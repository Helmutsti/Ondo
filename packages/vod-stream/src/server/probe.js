// Cosa c'è dentro un file video, letto con ffprobe: durata, dimensioni,
// codec e il tipo MIME completo (contenitore + codec) da passare a
// video.canPlayType() nel browser.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

function run(ffprobePath, file) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic',
      '-of', 'json', file
    ];
    const child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new Error(`ffprobe non avviabile (${ffprobePath}): ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe terminato con codice ${code}: ${err.trim().slice(-300)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function frameRate(raw) {
  if (typeof raw !== 'string') return null;
  const [n, d] = raw.split('/').map(Number);
  return n > 0 && d > 0 ? n / d : null;
}

// Stringhe di codec RFC 6381, quelle che canPlayType capisce. Per H.264
// profilo e livello cambiano la risposta del browser, e ffprobe li dà; per gli
// altri basta un valore rappresentativo.
const H264_PROFILE = { Baseline: '42', 'Constrained Baseline': '42', Main: '4d', High: '64' };
function codecString(stream, container) {
  if (!stream) return null;
  switch (stream.codec_name) {
    case 'h264': {
      const profile = H264_PROFILE[stream.profile] ?? '64';
      const level = stream.level > 0 ? stream.level.toString(16).padStart(2, '0') : '28';
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
    case 'ac3': return 'ac-3';
    case 'eac3': return 'ec-3';
    default: return stream.codec_name;
  }
}

function containerMime(formatName, ext) {
  if (/mp4|mov/.test(formatName)) return 'video/mp4';
  if (/matroska|webm/.test(formatName)) return ext === 'webm' ? 'video/webm' : 'video/x-matroska';
  if (/mpegts/.test(formatName)) return 'video/mp2t';
  return `video/${ext || 'mp4'}`;
}

/** Un lettore con cache per percorso: un file già letto e non cambiato non si rilegge. */
export function createProber(ffprobePath) {
  const cache = new Map();

  return async function probe(file) {
    const st = statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = cache.get(file);
    if (hit?.key === key) return hit.info;

    const raw = await run(ffprobePath, file);
    const streams = raw.streams ?? [];
    // Il primo flusso video vero: una copertina incorporata è anch'essa un
    // "video" di un fotogramma (attached_pic) e non è il film.
    const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) ?? null;
    const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
    if (!video) throw new Error('Il file non contiene un flusso video.');

    const ext = path.extname(file).slice(1).toLowerCase();
    const container = containerMime(raw.format?.format_name ?? '', ext);
    const codecs = [codecString(video, container), codecString(audio, container)].filter(Boolean);
    const duration = Number.parseFloat(raw.format?.duration);
    if (!(duration > 0)) throw new Error('Durata del video non leggibile.');

    const info = {
      key,
      duration,
      container,
      mimeType: codecs.length ? `${container}; codecs="${codecs.join(', ')}"` : container,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      fps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
      hasAudio: !!audio
    };
    cache.set(file, { key, info });
    return info;
  };
}
