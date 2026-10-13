// Le conversioni ffmpeg: una per (video, qualità), che produce segmenti HLS a
// partire da quello richiesto.
//
// Come risponde a una richiesta del segmento N:
//   - se il file N.ts è già in cache → subito;
//   - se c'è una conversione di quella qualità che sta per arrivarci (N è poco
//     più avanti dell'ultimo prodotto) → si aspetta lei;
//   - altrimenti (primo accesso, o salto lontano) → la conversione riparte da N.
//     Si paga solo il pezzo che serve, non tutto quello che c'è prima.
//
// Ogni conversione parte con un seek esatto all'inizio del segmento e
// fotogrammi chiave forzati ogni `segmentSeconds`: i segmenti cadono sempre
// sulla stessa griglia, qualunque sia il punto di partenza, e combaciano con la
// playlist VOD calcolata in anticipo. -output_ts_offset tiene i timestamp
// assoluti, così segmenti prodotti da conversioni diverse si incastrano.
//
// CPU: una conversione troppo avanti rispetto a chi guarda viene sospesa
// (SIGSTOP) e ripresa quando serve (SIGCONT); quelle senza richieste da un po'
// vengono chiuse; oltre `maxJobs` contemporanee si chiude la usata meno di
// recente.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const POLL_MS = 100;
const CAN_PAUSE = process.platform !== 'win32';

export function createEncoder(opts) {
  const {
    ffmpegPath, segmentSeconds, maxJobs, idleTimeoutMs, maxAheadSegments,
    preset, segmentTimeoutMs, log
  } = opts;
  const jobs = new Map(); // chiave "dir" → job

  function segPath(dir, index) {
    return path.join(dir, `${index}.ts`);
  }

  // Il segmento più alto prodotto senza buchi dalla partenza del job.
  function refreshProduced(job) {
    while (existsSync(segPath(job.dir, job.produced + 1))) job.produced++;
  }

  function stopJob(job, reason) {
    if (job.done) return;
    job.done = true;
    job.killed = true;
    try { job.proc.kill('SIGKILL'); } catch { /* già uscito */ }
    log(`vod-stream: chiusa conversione ${job.label} (${reason})`);
  }

  function setPaused(job, paused) {
    if (!CAN_PAUSE || job.done || job.paused === paused) return;
    try {
      job.proc.kill(paused ? 'SIGSTOP' : 'SIGCONT');
      job.paused = paused;
    } catch { /* processo già uscito */ }
  }

  function ffmpegArgs({ file, info, rendition, startIndex, dir }) {
    const start = startIndex * segmentSeconds;
    const outFps = info.fps && opts.maxFps && info.fps > opts.maxFps + 0.5 ? opts.maxFps : null;
    const filters = [`scale=${rendition.width}:${rendition.height}:flags=bicubic`];
    if (outFps) filters.push(`fps=${outFps}`);
    // -ss sempre, anche a 0, e niente B-frame (-bf 0): solo così i timestamp
    // di una conversione partita dall'inizio e di una partita da un salto
    // cadono sulla stessa griglia. Con i B-frame ffmpeg ritarda di due
    // fotogrammi solo le prime, e dove due conversioni si incontrano il player
    // salterebbe. Costa un po' di bitrate, e in cambio si codifica più in fretta.
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', start.toFixed(3)];
    args.push(
      '-i', file,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-level:v', '4.0', '-pix_fmt', 'yuv420p', '-bf', '0',
      '-crf', '23', '-maxrate', String(rendition.videoBitrate), '-bufsize', String(rendition.videoBitrate * 2),
      '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`, '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', String(rendition.audioBitrate), '-ac', '2', '-ar', '48000',
      '-output_ts_offset', start.toFixed(3),
      '-f', 'hls',
      '-hls_time', String(segmentSeconds),
      '-hls_list_size', '0',
      '-hls_segment_type', 'mpegts',
      // temp_file: un segmento compare con il suo nome solo quando è completo.
      '-hls_flags', 'temp_file+independent_segments',
      '-start_number', String(startIndex),
      '-hls_segment_filename', path.join(dir, '%d.ts'),
      // La playlist di ffmpeg non serve (la nostra è calcolata): va in un file a parte.
      path.join(dir, '.ffmpeg.m3u8')
    );
    return args;
  }

  function startJob({ id, file, info, rendition, startIndex, dir, label }) {
    // Pezzi a metà di una conversione chiusa di colpo.
    for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) rmSync(path.join(dir, f), { force: true });

    // Oltre il limite si chiude la conversione usata meno di recente.
    const running = [...jobs.values()].filter((j) => !j.done);
    if (running.length >= maxJobs) {
      running.sort((a, b) => a.lastAccess - b.lastAccess);
      for (const j of running.slice(0, running.length - maxJobs + 1)) stopJob(j, 'troppe conversioni insieme');
    }

    const proc = spawn(ffmpegPath, ffmpegArgs({ file, info, rendition, startIndex, dir }), { stdio: ['ignore', 'ignore', 'pipe'] });
    const job = {
      id, dir, label, proc, rendition,
      start: startIndex, produced: startIndex - 1, lastRequested: startIndex,
      lastAccess: Date.now(), done: false, killed: false, paused: false, error: null, stderr: ''
    };
    proc.stderr.on('data', (d) => { job.stderr = `${job.stderr}${d}`.slice(-2000); });
    proc.on('error', (err) => { job.done = true; job.error = `ffmpeg non avviabile (${ffmpegPath}): ${err.message}`; });
    proc.on('close', (code) => {
      job.done = true;
      refreshProduced(job);
      if (code !== 0 && !job.killed) {
        job.error = `ffmpeg terminato con codice ${code}: ${job.stderr.trim().split('\n').slice(-3).join(' | ')}`;
        log(`vod-stream: ${label} — ${job.error}`);
      }
    });
    jobs.set(dir, job);
    log(`vod-stream: avviata conversione ${label} dal segmento ${startIndex}`);
    return job;
  }

  /**
   * Il percorso del segmento `index` di (video, qualità), prodotto se serve.
   * `signal`: la richiesta HTTP chiusa dal client smette di aspettare (la
   * conversione no: il segmento servirà a chi lo chiede subito dopo).
   */
  async function getSegment({ id, file, info, rendition, index, totalSegments, dir, signal }) {
    mkdirSync(dir, { recursive: true });
    const target = segPath(dir, index);
    const label = `${id}/${rendition.name}`;
    let job = jobs.get(dir);

    if (existsSync(target)) {
      if (job && !job.done && index >= job.start) {
        job.lastRequested = Math.max(job.lastRequested, index);
        job.lastAccess = Date.now();
      }
      return target;
    }

    if (job && !job.done) refreshProduced(job);
    // Riusabile se sta per arrivare al segmento richiesto: entro un paio di
    // segmenti dall'ultimo prodotto.
    const reusable = job && !job.done && !job.error && index >= job.start && index <= job.produced + 3;
    if (!reusable) {
      if (job && !job.done) stopJob(job, `salto al segmento ${index}`);
      // Si parte dal primo segmento mancante: quelli dopo già in cache restano.
      let startIndex = index;
      while (startIndex < totalSegments - 1 && existsSync(segPath(dir, startIndex))) startIndex++;
      job = startJob({ id, file, info, rendition, startIndex, dir, label });
    }

    job.lastRequested = Math.max(job.lastRequested, index);
    job.lastAccess = Date.now();
    setPaused(job, false);

    const deadline = Date.now() + segmentTimeoutMs;
    while (!existsSync(target)) {
      if (signal?.aborted) throw Object.assign(new Error('Richiesta annullata.'), { code: 'ABORTED' });
      if (job.error) throw new Error(job.error);
      if (job.done) {
        refreshProduced(job);
        if (!existsSync(target)) throw new Error(`La conversione è finita senza produrre il segmento ${index}.`);
        break;
      }
      if (Date.now() > deadline) throw new Error(`Segmento ${index} non pronto entro ${segmentTimeoutMs / 1000}s.`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    job.lastAccess = Date.now();
    return target;
  }

  // Manutenzione: sospende chi corre troppo avanti, riprende chi serve, chiude
  // le conversioni abbandonate.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [dir, job] of jobs) {
      if (job.done) { if (now - job.lastAccess > idleTimeoutMs) jobs.delete(dir); continue; }
      if (now - job.lastAccess > idleTimeoutMs) { stopJob(job, 'nessuno la guarda'); continue; }
      refreshProduced(job);
      const ahead = job.produced - job.lastRequested;
      if (!job.paused && ahead > maxAheadSegments) setPaused(job, true);
      else if (job.paused && ahead < maxAheadSegments / 2) setPaused(job, false);
    }
  }, 1000);
  timer.unref();

  return {
    getSegment,
    /** Le conversioni su un percorso (per non cancellarne la cache mentre lavorano). */
    isActive(dir) {
      for (const job of jobs.values()) if (!job.done && job.dir.startsWith(dir)) return true;
      return false;
    },
    close() {
      clearInterval(timer);
      for (const job of jobs.values()) stopJob(job, 'chiusura');
      jobs.clear();
    }
  };
}
