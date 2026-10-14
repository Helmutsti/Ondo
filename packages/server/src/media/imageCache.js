import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Copie ridotte di copertine e foto dei creator, per gli elenchi: una card
// disegna la copertina a ~360 px e la foto a 22-40 px, ma riceveva l'originale
// (1280×720, e foto fino a ~600 KB), che il telefono deve anche decodificare.
//
//   /media/thumbnails/<file>?w=640   → copia larga al massimo 640 px
//   /media/avatars/<file>?w=96       → lato corto al massimo 96 px
//
// Senza `w` (o con una larghezza non prevista) passa l'originale, come prima.
// Le copie si creano con ffmpeg la prima volta che servono e vanno in
// ONDO_CACHE_DIR (nell'immagine Docker /cache): una cartella che si può
// cancellare in qualunque momento, si riempie di nuovo da sola. Il nome della
// copia dipende da dimensione e data del file originale, quindi una copertina
// sostituita non riusa la copia vecchia.

export const IMAGE_WIDTHS = [96, 320, 640];
const MAX_JOBS = 3;

export function imageCacheRoot() {
  const dir = process.env.ONDO_CACHE_DIR?.trim();
  return path.join(dir ? path.resolve(dir) : path.join(os.tmpdir(), 'ondo-cache'), 'images');
}

/**
 * Middleware Express da mettere prima di express.static sulla stessa cartella.
 * @param {object} o
 * @param {string} o.baseDir     la cartella degli originali
 * @param {string} o.kind        'thumbnails' | 'avatars' (sottocartella della cache)
 * @param {'width'|'short'} o.fit 'width' = larghezza massima; 'short' = lato corto massimo
 * @param {string} o.ffmpegPath
 */
export function resizedImages({ baseDir, kind, fit, ffmpegPath }) {
  const root = path.resolve(baseDir);
  const inFlight = new Map(); // percorso della copia → Promise
  const queue = [];
  let running = 0;

  function pump() {
    while (running < MAX_JOBS && queue.length) {
      const job = queue.shift();
      running++;
      job().finally(() => { running--; pump(); });
    }
  }

  function scaleFilter(w) {
    if (fit === 'short') {
      // Lato corto a w (mai ingrandire): l'altro lato in proporzione.
      return `scale='if(gt(iw,ih),-2,min(iw,${w}))':'if(gt(iw,ih),min(ih,${w}),-2)'`;
    }
    return `scale='min(iw,${w})':-2`;
  }

  function generate(src, out, w) {
    if (inFlight.has(out)) return inFlight.get(out);
    const p = new Promise((resolve, reject) => {
      queue.push(() => new Promise((done) => {
        mkdirSync(path.dirname(out), { recursive: true });
        const tmp = `${out}.${process.pid}.tmp.jpg`;
        const proc = spawn(ffmpegPath, ['-v', 'error', '-nostdin', '-y', '-i', src, '-vf', scaleFilter(w), '-frames:v', '1', '-q:v', '4', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        proc.stderr.on('data', (d) => { err = `${err}${d}`.slice(-500); });
        proc.on('error', (e) => { reject(e); done(); });
        proc.on('close', (code) => {
          if (code === 0 && existsSync(tmp)) {
            renameSync(tmp, out);
            resolve(out);
          } else {
            rmSync(tmp, { force: true });
            reject(new Error(`ffmpeg ${code}: ${err.trim()}`));
          }
          done();
        });
      }));
      pump();
    }).finally(() => inFlight.delete(out));
    inFlight.set(out, p);
    return p;
  }

  return async function resizedImage(req, res, next) {
    const w = Number(req.query.w);
    if (!IMAGE_WIDTHS.includes(w)) return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    const src = path.resolve(root, `.${rel}`);
    if (!src.startsWith(root + path.sep)) return next();
    let st;
    try { st = statSync(src); } catch { return next(); }
    if (!st.isFile()) return next();

    const key = createHash('sha1').update(`${rel}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 16);
    const out = path.join(imageCacheRoot(), kind, String(w), `${key}.jpg`);
    try {
      if (!existsSync(out)) await generate(src, out, w);
    } catch (e) {
      // Una copia che non si riesce a fare non deve lasciare un buco: si
      // manda l'originale.
      console.warn(`immagini ridotte: ${kind}${rel} a ${w} px — ${e.message}`);
      return next();
    }
    // L'indirizzo cambia quando cambia l'immagine (?v=…): la copia si può
    // tenere a lungo.
    res.sendFile(out, { maxAge: '30d' });
  };
}
