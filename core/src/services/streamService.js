// Riproduzione sui dispositivi che non leggono il file così com'è (iPhone, iPad,
// Safari in genere).
//
// I video si scaricano alla qualità massima: su YouTube vuol dire quasi sempre
// VP9 o AV1 con audio Opus, spesso in MKV o WebM. Chrome e Firefox li leggono;
// Safari no (MKV mai, VP9/AV1/Opus a seconda di modello e versione di iOS).
// L'unica combinazione che parte ovunque è H.264 + AAC — ma convertire
// l'archivio vorrebbe dire rinunciare alla qualità o raddoppiare lo spazio.
//
// Quindi si converte al volo, e solo quando serve: il browser riceve da
// getPlaybackInfo il tipo esatto del file (contenitore e codec, misurati con
// ffprobe) e chiede a sé stesso se lo sa riprodurre (canPlayType). Se no, e se
// sa riprodurre HLS — che è il formato di streaming nativo di iPhone — chiede
// /media/hls/<id>/index.m3u8: qui parte ffmpeg e produce segmenti HLS man mano.
//
//   video già H.264 8 bit → copiato così com'è (si cambia solo il contenitore)
//   video VP9/AV1/altro   → ricodificato in H.264, al massimo 1080p
//   audio non AAC         → convertito in AAC
//
// Il primo caso è quasi istantaneo; il secondo va più veloce del tempo reale,
// quindi si guarda subito e ci si sposta in avanti fin dove la conversione è
// arrivata (la playlist è di tipo EVENT e cresce). I segmenti stanno nell'area
// di lavoro (ONDO_SCRATCH_DIR, o la cartella temporanea del sistema) e si
// cancellano quando nessuno li chiede più da un po'.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPaths, expectedToolNames } from '../config.js';
import { scratchRoot } from '../lib/scratch.js';
import { getVideo } from './videoService.js';

// Quanto aspettare il primo segmento prima di rinunciare, quanti minuti di
// silenzio (nessuna richiesta di playlist o segmenti) fermano una conversione
// in corso, e dopo quanto si cancellano i segmenti di una conversione finita.
const FIRST_SEGMENT_TIMEOUT_MS = 30_000;
// Largo: Safari in pausa può smettere di chiedere la playlist, e chi riprende
// dopo qualche minuto deve trovare la conversione dove l'aveva lasciata.
const IDLE_STOP_MS = 10 * 60_000;
const IDLE_DELETE_MS = 30 * 60_000;
// Conversioni contemporanee: ricodificare in H.264 impegna tutta la CPU. Oltre
// il limite si ferma quella usata meno di recente — chi apre un video nuovo
// vuole quello, non quello di prima.
const MAX_RUNNING = 2;
const SEGMENT_SECONDS = 4;

function toolCommand(name) {
  const { ffmpegLocation } = getPaths();
  const bin = expectedToolNames()[name];
  if (ffmpegLocation) {
    const candidate = path.join(ffmpegLocation, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

function hlsRoot() {
  const scratch = scratchRoot();
  return scratch ? path.join(scratch, 'hls') : path.join(os.tmpdir(), 'ondo-hls');
}

// ── Cosa c'è nel file ────────────────────────────────────────────────────────

const probeCache = new Map(); // percorso → { key, info }

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_type,codec_name,profile,level,pix_fmt,height', '-of', 'json', filePath];
    const child = spawn(toolCommand('ffprobe'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe terminato con codice ${code}: ${err.trim().slice(-300)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

async function probeFile(filePath) {
  const st = statSync(filePath);
  const key = `${st.size}:${st.mtimeMs}`;
  const cached = probeCache.get(filePath);
  if (cached?.key === key) return cached.info;
  const raw = await runFfprobe(filePath);
  const streams = raw.streams ?? [];
  // Il primo flusso video "vero": una copertina incorporata è anch'essa un
  // flusso video (mjpeg/png), e non è il film.
  const video = streams.find((s) => s.codec_type === 'video' && !['mjpeg', 'png'].includes(s.codec_name)) ?? null;
  const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
  const info = { formatName: raw.format?.format_name ?? '', video, audio, ext: path.extname(filePath).slice(1).toLowerCase() };
  probeCache.set(filePath, { key, info });
  return info;
}

// Stringhe di codec nel formato che canPlayType capisce (RFC 6381). Bastano
// approssimate dove il dettaglio non cambia la risposta del browser; per H.264
// profilo e livello contano, e li dà ffprobe.
const H264_PROFILE = { Baseline: '42', 'Constrained Baseline': '42', Main: '4d', High: '64' };
function codecString(stream, container) {
  if (!stream) return null;
  switch (stream.codec_name) {
    case 'h264': {
      const profile = H264_PROFILE[stream.profile] ?? '64';
      const level = Number.isFinite(stream.level) && stream.level > 0 ? stream.level.toString(16).padStart(2, '0') : '28';
      return `avc1.${profile}00${level}`;
    }
    case 'hevc': return 'hvc1.1.6.L120.90';
    case 'vp9': return container === 'video/webm' ? 'vp9' : 'vp09.00.40.08';
    case 'vp8': return 'vp8';
    case 'av1': return 'av01.0.08M.08';
    case 'aac': return 'mp4a.40.2';
    case 'mp3': return 'mp3';
    case 'opus': return 'opus';
    case 'vorbis': return 'vorbis';
    case 'flac': return 'flac';
    default: return stream.codec_name;
  }
}

function containerMime(info) {
  if (/mp4|mov/.test(info.formatName)) return 'video/mp4';
  if (/matroska|webm/.test(info.formatName)) return info.ext === 'webm' ? 'video/webm' : 'video/x-matroska';
  return `video/${info.ext || 'mp4'}`;
}

function absVideoPath(video) {
  const rel = video.video?.localPath;
  if (!rel) throw new Error('Questo video non è scaricato.');
  const abs = path.join(getPaths().videosDir, rel);
  if (!existsSync(abs)) throw new Error(`File del video non trovato: ${rel}`);
  return abs;
}

/**
 * Il tipo del file di un video, per decidere nel browser se riprodurlo così
 * com'è o convertito. `mimeType` è pronto per video.canPlayType().
 */
export async function getPlaybackInfo(videoId) {
  const video = await getVideo(videoId);
  const info = await probeFile(absVideoPath(video));
  const container = containerMime(info);
  const codecs = [codecString(info.video, container), codecString(info.audio, container)].filter(Boolean);
  return {
    mimeType: codecs.length ? `${container}; codecs="${codecs.join(', ')}"` : container,
    container,
    videoCodec: info.video?.codec_name ?? null,
    audioCodec: info.audio?.codec_name ?? null,
    // Cosa farà la conversione, se serve: per dire all'utente quanto aspetterà.
    hlsCopiesVideo: canCopyVideo(info)
  };
}

// ── Conversione HLS ──────────────────────────────────────────────────────────

const sessions = new Map(); // videoId → { dir, proc, done, error, lastAccess }

function canCopyVideo(info) {
  return info.video?.codec_name === 'h264' && (info.video.pix_fmt ?? 'yuv420p') === 'yuv420p';
}

function ffmpegArgs(input, info, dir) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  if (canCopyVideo(info)) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-profile:v', 'high', '-level:v', '4.1',
      // Al massimo 1080p: è il limite dell'H.264 "facile" per un iPhone e tiene
      // la conversione più veloce del tempo reale anche partendo da un 4K.
      '-vf', "scale=-2:'min(1080,ih)'",
      // Un fotogramma chiave all'inizio di ogni segmento: segmenti tutti della
      // stessa durata e salti precisi.
      '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`
    );
  }
  if (info.audio?.codec_name === 'aac') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'event',
    // temp_file: la playlist si riscrive con un rename, Safari non ne legge mai
    // una a metà.
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8')
  );
  return args;
}

function stopSession(videoId, { remove = false } = {}) {
  const s = sessions.get(videoId);
  if (!s) return;
  if (s.proc && !s.done) {
    s.stopped = true;
    s.proc.kill('SIGKILL');
  }
  if (remove) {
    rmSync(s.dir, { recursive: true, force: true });
    sessions.delete(videoId);
  }
}

function playlistReady(dir) {
  const file = path.join(dir, 'index.m3u8');
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf-8').includes('#EXTINF');
}

function startSession(videoId, input, info) {
  const running = [...sessions.entries()].filter(([, s]) => !s.done);
  if (running.length >= MAX_RUNNING) {
    running.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [id] of running.slice(0, running.length - MAX_RUNNING + 1)) stopSession(id, { remove: true });
  }
  const dir = path.join(hlsRoot(), videoId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const session = { dir, proc: null, done: false, error: null, stopped: false, lastAccess: Date.now() };
  const proc = spawn(toolCommand('ffmpeg'), ffmpegArgs(input, info, dir), { stdio: ['ignore', 'ignore', 'pipe'] });
  let errTail = '';
  proc.stderr.on('data', (d) => { errTail = `${errTail}${d}`.slice(-1000); });
  proc.on('error', (err) => { session.done = true; session.error = err.message; });
  proc.on('close', (code) => {
    session.done = true;
    if (code !== 0 && !session.stopped) session.error = `ffmpeg terminato con codice ${code}: ${errTail.trim()}`;
  });
  session.proc = proc;
  sessions.set(videoId, session);
  return session;
}

/**
 * Assicura che la conversione HLS di un video sia avviata e abbia prodotto
 * almeno il primo segmento. Ritorna la cartella con index.m3u8 e i segmenti.
 */
export async function ensureHlsStream(videoId) {
  let session = sessions.get(videoId);
  // Riparte da capo se la precedente è stata fermata a metà o è fallita: una
  // playlist EVENT rimasta senza fine non finirebbe mai di caricarsi.
  if (session && (session.error || session.stopped || !existsSync(session.dir))) {
    stopSession(videoId, { remove: true });
    session = null;
  }
  if (!session) {
    const video = await getVideo(videoId);
    const input = absVideoPath(video);
    const info = await probeFile(input);
    if (!info.video) throw new Error('Il file non contiene un flusso video.');
    session = startSession(videoId, input, info);
  }
  session.lastAccess = Date.now();

  const deadline = Date.now() + FIRST_SEGMENT_TIMEOUT_MS;
  while (!playlistReady(session.dir)) {
    if (session.error) throw new Error(session.error);
    if (session.done && !playlistReady(session.dir)) throw new Error('Conversione terminata senza produrre video.');
    if (Date.now() > deadline) throw new Error('La conversione non è partita in tempo.');
    await new Promise((r) => setTimeout(r, 250));
  }
  return session.dir;
}

/** Segna una richiesta di segmento: tiene viva la conversione. Ritorna la cartella, o null. */
export function touchHlsStream(videoId) {
  const s = sessions.get(videoId);
  if (!s) return null;
  s.lastAccess = Date.now();
  return s.dir;
}

// Pulizia: ferma le conversioni che nessuno guarda più e cancella i segmenti
// vecchi. unref: il timer non tiene in vita il processo (CLI, test).
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const idle = now - s.lastAccess;
    if (idle > IDLE_DELETE_MS) stopSession(id, { remove: true });
    else if (!s.done && idle > IDLE_STOP_MS) stopSession(id, { remove: true });
  }
}, 30_000).unref();
