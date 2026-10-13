// vod-stream — lato server. Vedi README.md per l'integrazione.
//
//   const vod = createVodStream({ resolveFile: async (id) => '/percorso/del/file.mkv', cacheDir: '/tmp/vod' });
//   app.use('/stream', vod.handler);       // Express, Connect, o http.createServer
//
// Rotte servite (sotto il punto di montaggio, con <id> codificato con encodeURIComponent):
//   GET <id>/info.json            tipo del file (per canPlayType), durata, qualità disponibili
//   GET <id>/master.m3u8          playlist HLS principale, una variante per qualità
//   GET <id>/<qualità>/index.m3u8 playlist VOD completa di una qualità
//   GET <id>/<qualità>/<n>.ts     segmento n, prodotto su richiesta se non è in cache

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createProber } from './probe.js';
import { createEncoder } from './encoder.js';
import { masterPlaylist, mediaPlaylist, segmentCount } from './playlists.js';

/** Le qualità predefinite. La prima elencata (nel master) è quella di partenza. */
export const DEFAULT_RENDITIONS = [
  { name: '360p', height: 360, videoBitrate: 900_000, audioBitrate: 96_000 },
  { name: '720p', height: 720, videoBitrate: 3_000_000, audioBitrate: 128_000 },
  { name: '1080p', height: 1080, videoBitrate: 6_000_000, audioBitrate: 160_000 },
  { name: '1440p', height: 1440, videoBitrate: 10_000_000, audioBitrate: 160_000 },
  { name: '2160p', height: 2160, videoBitrate: 18_000_000, audioBitrate: 160_000 }
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function createVodStream(options = {}) {
  const {
    resolveFile,
    cacheDir,
    ffmpegPath = 'ffmpeg',
    ffprobePath = 'ffprobe',
    segmentSeconds = 4,
    renditions = DEFAULT_RENDITIONS,
    maxHeight = 1080,
    maxFps = 30,
    startRendition = null,
    preset = 'veryfast',
    maxJobs = 3,
    maxCacheBytes = 2 * 1024 ** 3,
    idleTimeoutMs = 60_000,
    maxAheadSeconds = 90,
    segmentTimeoutMs = 45_000,
    cors = false,
    log = () => {}
  } = options;
  if (typeof resolveFile !== 'function') throw new Error('vod-stream: serve resolveFile(id) → percorso del file.');
  if (!cacheDir) throw new Error('vod-stream: serve cacheDir, la cartella dei segmenti convertiti.');

  const probe = createProber(ffprobePath);
  const encoder = createEncoder({
    ffmpegPath, segmentSeconds, maxJobs, idleTimeoutMs, preset, segmentTimeoutMs, maxFps, log,
    maxAheadSegments: Math.max(3, Math.round(maxAheadSeconds / segmentSeconds))
  });

  // Le qualità per QUESTO file: niente sopra la sua risoluzione (ingrandire
  // costa CPU e non aggiunge nulla) né sopra maxHeight. Un file più piccolo
  // della qualità minima ne ha una sola, alla sua altezza.
  function renditionsFor(info) {
    const srcH = info.height || 1080;
    const srcW = info.width || Math.round((srcH * 16) / 9);
    const limit = Math.min(srcH, maxHeight);
    let list = renditions.filter((r) => r.height <= limit);
    if (list.length === 0) list = [{ ...renditions[0], name: `${even(limit)}p`, height: even(limit) }];
    list = list.map((r) => ({ ...r, height: even(r.height), width: even((srcW * r.height) / srcH) }));
    const first = list.find((r) => r.name === startRendition) ?? list[0];
    return [first, ...list.filter((r) => r !== first)];
  }

  // Cartella di cache di un file: dipende da id, dimensione e data di modifica,
  // così un file sostituito non riusa i segmenti del vecchio.
  function cacheDirFor(id, info) {
    const slug = String(id).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
    const hash = createHash('sha1').update(`${id}\0${info.key}`).digest('hex').slice(0, 12);
    return path.join(cacheDir, `${slug}-${hash}`);
  }

  async function load(id) {
    const file = await resolveFile(id);
    if (!file || !existsSync(file)) {
      const err = new Error(`Video non trovato: ${id}`);
      err.status = 404;
      throw err;
    }
    const info = await probe(file);
    return { file, info, list: renditionsFor(info), dir: cacheDirFor(id, info) };
  }

  /** Le informazioni di riproduzione di un video (quelle di <id>/info.json). */
  async function info(id) {
    const { info: i, list } = await load(id);
    return {
      duration: i.duration,
      container: i.container,
      mimeType: i.mimeType,
      videoCodec: i.videoCodec,
      audioCodec: i.audioCodec,
      width: i.width,
      height: i.height,
      fps: i.fps,
      renditions: list.map(({ name, width, height }) => ({ name, width, height })),
      // Relativo a info.json: il client lo risolve con new URL(…, infoUrl).
      masterPlaylist: 'master.m3u8'
    };
  }

  // ── Cache: oltre maxCacheBytes si cancellano le cartelle dei video toccati
  // meno di recente, mai quelle con una conversione in corso.
  function dirSize(dir) {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : statSync(p).size;
    }
    return total;
  }
  const cacheTimer = setInterval(() => {
    try {
      if (!existsSync(cacheDir)) return;
      const entries = readdirSync(cacheDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const p = path.join(cacheDir, e.name);
          return { p, size: dirSize(p), mtime: statSync(p).mtimeMs };
        });
      let total = entries.reduce((s, e) => s + e.size, 0);
      if (total <= maxCacheBytes) return;
      entries.sort((a, b) => a.mtime - b.mtime);
      for (const e of entries) {
        if (total <= maxCacheBytes * 0.8) break;
        if (encoder.isActive(e.p)) continue;
        rmSync(e.p, { recursive: true, force: true });
        total -= e.size;
        log(`vod-stream: cache piena, cancellato ${path.basename(e.p)}`);
      }
    } catch (err) {
      log(`vod-stream: pulizia della cache fallita: ${err.message}`);
    }
  }, 60_000);
  cacheTimer.unref();

  // ── HTTP ───────────────────────────────────────────────────────────────────
  function send(res, status, type, body, extra = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(body);
  }

  async function handler(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next ? next() : send(res, 405, 'text/plain', 'Metodo non permesso');
    const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean);
    let decoded;
    try { decoded = parts.map(decodeURIComponent); } catch { return send(res, 400, 'text/plain', 'URL non valido'); }
    const notFound = () => (next ? next() : send(res, 404, 'text/plain', 'Non trovato'));
    const common = cors ? { 'Access-Control-Allow-Origin': '*' } : {};

    // Il client che chiude la connessione (salto nel video, pagina chiusa)
    // smette di aspettare il segmento.
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });

    try {
      if (decoded.length === 2 && decoded[1] === 'info.json') {
        return send(res, 200, 'application/json', JSON.stringify(await info(decoded[0])), { ...common, 'Cache-Control': 'no-cache' });
      }
      if (decoded.length === 2 && decoded[1] === 'master.m3u8') {
        const { info: i, list } = await load(decoded[0]);
        const outFps = i.fps && i.fps > maxFps + 0.5 ? maxFps : i.fps;
        return send(res, 200, 'application/vnd.apple.mpegurl', masterPlaylist(list, { hasAudio: i.hasAudio, fps: outFps }), { ...common, 'Cache-Control': 'no-cache' });
      }
      if (decoded.length === 3) {
        const [id, name, leaf] = decoded;
        const { file, info: i, list, dir } = await load(id);
        const rendition = list.find((r) => r.name === name);
        if (!rendition) return notFound();
        if (leaf === 'index.m3u8') {
          return send(res, 200, 'application/vnd.apple.mpegurl', mediaPlaylist(i.duration, segmentSeconds), { ...common, 'Cache-Control': 'no-cache' });
        }
        const m = /^(\d+)\.ts$/.exec(leaf);
        if (!m) return notFound();
        const index = Number(m[1]);
        const total = segmentCount(i.duration, segmentSeconds);
        if (index >= total) return notFound();
        const segFile = await encoder.getSegment({
          id, file, info: i, rendition, index, totalSegments: total,
          dir: path.join(dir, rendition.name), signal: abort.signal
        });
        const size = statSync(segFile).size;
        res.writeHead(200, { ...common, 'Content-Type': 'video/mp2t', 'Content-Length': size, 'Cache-Control': 'private, max-age=3600' });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(segFile).pipe(res);
      }
      return notFound();
    } catch (err) {
      if (err.code === 'ABORTED' || res.headersSent) return undefined;
      log(`vod-stream: ${req.url} — ${err.message}`);
      return send(res, err.status ?? 500, 'text/plain; charset=utf-8', err.message, common);
    }
  }

  return {
    handler,
    info,
    close() {
      clearInterval(cacheTimer);
      encoder.close();
    },
    /** Per test e diagnosi: la cartella di cache di un video. */
    async cachePath(id) {
      return (await load(id)).dir;
    }
  };
}

