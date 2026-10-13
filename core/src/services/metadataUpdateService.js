import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getPaths, getToolPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { DOWNLOAD_STATE } from '../catalog/catalogSchema.js';
import { fetchVideoMetadata } from '../ytdlp/ytdlpWrapper.js';
import { classifyYtdlpError, errorRecord } from '../ytdlp/errorClassifier.js';
import { stagingDirFor, removeStagingDir, moveFile } from '../lib/scratch.js';
import { applyRemoteVerdict, checkVideoPresence } from './presenceService.js';
import { META_FIELDS, FIELD_NAMES, EDITABLE_FIELDS, mergeVideoFields, isEmptyValue } from './metadataFields.js';

// Aggiornamento mirato dei metadati (redesign R4). Mai più "di nascosto":
// si sceglie quali campi, con quali regole, e le differenze da decidere vanno
// in revisione. Ogni cambio finisce nella cronologia del video (annullabile),
// e le copertine sostituite restano su disco accanto a quella attuale.

const HISTORY_LIMIT = 40;

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// L'aspetto di un'immagine: ridotta a 16×16 in grigi con ffmpeg (già usato
// da yt-dlp per le copertine). null se ffmpeg non risponde: si torna al solo
// confronto dei byte.
function lookOf(file) {
  try {
    const { ffmpegLocation } = getToolPaths();
    const bin = ffmpegLocation ? path.join(ffmpegLocation, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg';
    const r = spawnSync(bin, ['-v', 'error', '-i', file, '-vf', 'scale=16:16:flags=area,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 16, timeout: 15000 });
    return r.status === 0 && r.stdout?.length === 256 ? r.stdout.toString('base64') : null;
  } catch {
    return null;
  }
}

function thumbAbs(rel) {
  return rel ? path.join(getPaths().thumbnailsDir, rel) : null;
}

// Il valore "copertina" del video, con l'impronta calcolata se manca (le
// copertine scaricate prima di oggi non ce l'hanno).
function currentThumbnail(video) {
  const rel = video.thumbnail?.localPath;
  const abs = thumbAbs(rel);
  if (!rel || !existsSync(abs)) return null;
  return { file: rel, sha: video.thumbnail?.sha256 ?? sha256File(abs), look: lookOf(abs) };
}

function pushHistory(video, entries) {
  if (!entries.length) return;
  video.metadataHistory = [...entries, ...(video.metadataHistory ?? [])].slice(0, HISTORY_LIMIT);
}

function historyEntry(field, from, to, origin, label) {
  return { id: randomUUID().slice(0, 8), field, from: from ?? null, to: to ?? null, origin, label: label ?? null, at: new Date().toISOString() };
}

// Accanto alla copertina attuale, con un nome che dice cos'è: le immagini
// restano nella stessa cartella (il backup le prende come le altre).
function siblingName(rel, videoId, suffix) {
  const dir = rel ? path.dirname(rel) : '.';
  const name = `${videoId}.${suffix}.jpg`;
  return dir === '.' ? name : path.join(dir, name);
}

// I campi "tecnici" (non decisi dall'utente) arrivati col recupero: si
// aggiornano sempre, ma senza mai svuotare un valore che c'era.
const TECH_FIELDS = ['categories', 'language', 'ageLimit', 'availability', 'license', 'isLive', 'wasLive', 'thumbnails', 'subtitleLanguagesAvailable', 'releaseTimestamp', 'webpageUrl', 'extractor'];
function applyTechFields(video, meta) {
  for (const k of TECH_FIELDS) {
    if (k in meta && !isEmptyValue(meta[k])) video[k] = meta[k];
  }
  if (meta.channel) {
    video.channel = video.channel ?? {};
    for (const [k, v] of Object.entries(meta.channel)) {
      if (v != null && v !== '' && (video.channel[k] == null || video.channel[k] === '' || k === 'subscriberCountAtDownload')) video.channel[k] = v;
    }
  }
  // La risoluzione e le statistiche "al download" descrivono il file: si
  // aggiornano solo finché il video non è stato scaricato.
  if (video.download !== DOWNLOAD_STATE.DOWNLOADED) {
    if (meta.resolution) video.resolution = meta.resolution;
    if (meta.statsAtDownload) video.statsAtDownload = meta.statsAtDownload;
  }
}

/**
 * Aggiorna i metadati di UN video secondo campi e regole.
 * @returns {{ outcome: 'updated'|'unchanged'|'review'|'removed'|'restricted'|'error'|'stop', applied: string[], review: string[], locked: string[], classification?: object }}
 */
export async function updateVideoMetadata(videoId, { fields = FIELD_NAMES, rules = {}, label = null, origin = 'wizard' } = {}) {
  const catalog = await readCatalog();
  const video = catalog.videos[videoId];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${videoId}`);
  const metaFields = fields.filter((f) => META_FIELDS[f]);

  // Solo la presenza: una richiesta leggera, niente metadati né copertina.
  if (metaFields.length === 0) {
    const { outcome, classification } = await checkVideoPresence(videoId);
    if (outcome === 'stop') return { outcome: 'stop', applied: [], review: [], locked: [], classification };
    const mapped = outcome === 'removed' || outcome === 'confirmed' ? 'removed' : outcome === 'restricted' ? 'restricted' : classification && outcome === 'unchanged' ? 'error' : 'unchanged';
    return { outcome: mapped, applied: [], review: [], locked: [], classification };
  }

  const scratch = stagingDirFor(`meta-${videoId}`);
  const work = scratch ?? mkdtempSync(path.join(tmpdir(), `ondo-meta-${videoId}-`));
  try {
    let meta;
    try {
      const { video: _ignore, ...m } = await fetchVideoMetadata(videoId, video.webpageUrl, { outDir: work });
      meta = m;
    } catch (err) {
      const classification = classifyYtdlpError(err);
      const outcome = await updateCatalog((cat) => {
        const cur = cat.videos[videoId];
        if (!cur) return null;
        const res = applyRemoteVerdict(cur, classification, { isCheck: false }).outcome;
        if (res !== 'stop') {
          cur.enrichError = errorRecord(classification, { attempts: (cur.enrichError?.attempts ?? 0) + 1 });
          cur.updatedAt = new Date().toISOString();
        }
        return res;
      });
      if (outcome === 'stop') return { outcome: 'stop', applied: [], review: [], locked: [], classification };
      if (outcome === 'removed' || outcome === 'confirmed') return { outcome: 'removed', applied: [], review: [], locked: [], classification };
      if (outcome === 'restricted') return { outcome: 'restricted', applied: [], review: [], locked: [], classification };
      return { outcome: 'error', applied: [], review: [], locked: [], classification };
    }

    // I valori nuovi per i campi scelti. La copertina nuova resta nella
    // cartella di lavoro finché non si sa se serve.
    const incoming = {};
    for (const f of metaFields) {
      if (f === 'thumbnail') {
        const tmp = meta.thumbnail?.localPath ? path.join(work, meta.thumbnail.localPath) : null;
        incoming.thumbnail = tmp && existsSync(tmp) ? { file: tmp, sha: sha256File(tmp), look: lookOf(tmp), tmp: true } : null;
      } else {
        incoming[f] = META_FIELDS[f].value(meta);
      }
    }
    const curThumb = currentThumbnail(video);
    const withThumb = { ...video, thumbnail: { ...(video.thumbnail ?? {}), ...(curThumb ? { localPath: curThumb.file, sha256: curThumb.sha } : {}) } };
    const merged = mergeVideoFields(withThumb, incoming, { fields: metaFields, rules, currentThumbnail: curThumb });

    // Copertina: spostamenti su disco PRIMA di scrivere il catalogo.
    let thumbApply = null;
    let thumbReview = null;
    if (merged.apply.thumbnail) {
      const cur = currentThumbnail(video);
      const dest = cur?.file ?? `${videoId}.jpg`;
      let from = null;
      if (cur) {
        const prev = siblingName(cur.file, videoId, `prima-${Date.now()}`);
        await moveFile(thumbAbs(cur.file), thumbAbs(prev));
        from = { file: prev, sha: cur.sha };
      }
      await moveFile(incoming.thumbnail.file, thumbAbs(dest));
      thumbApply = { from, to: { file: dest, sha: incoming.thumbnail.sha } };
    } else if (merged.review.thumbnail) {
      const cur = currentThumbnail(video);
      const pending = siblingName(cur?.file, videoId, 'nuova');
      mkdirSync(path.dirname(thumbAbs(pending)), { recursive: true });
      await moveFile(incoming.thumbnail.file, thumbAbs(pending));
      thumbReview = { current: cur, incoming: { file: pending, sha: incoming.thumbnail.sha } };
    }

    const applied = Object.keys(merged.apply);
    const review = Object.keys(merged.review);
    await updateCatalog((cat) => {
      const cur = cat.videos[videoId];
      if (!cur) return;
      const entries = [];
      for (const f of applied) {
        const change = f === 'thumbnail' ? thumbApply : merged.apply[f];
        META_FIELDS[f].apply(cur, change.to);
        entries.push(historyEntry(f, change.from, change.to, origin, label));
      }
      pushHistory(cur, entries);
      applyTechFields(cur, meta);
      if (review.length) {
        const prevPending = cur.pendingReview?.fields?.thumbnail?.incoming?.file;
        cur.pendingReview = {
          label, origin, at: new Date().toISOString(),
          fields: Object.fromEntries(review.map((f) => [f, f === 'thumbnail' ? thumbReview : merged.review[f]]))
        };
        if (prevPending && prevPending !== thumbReview?.incoming?.file) {
          try { unlinkSync(thumbAbs(prevPending)); } catch { /* già sparita */ }
        }
      }
      cur.enrichedAt = new Date().toISOString();
      cur.enrichError = null;
      cur.updatedAt = cur.enrichedAt;
      applyRemoteVerdict(cur, null, { isCheck: false });
    });

    const outcome = review.length ? 'review' : applied.length ? 'updated' : 'unchanged';
    return { outcome, applied, review, locked: merged.locked };
  } finally {
    if (scratch) removeStagingDir(scratch); else rmSync(work, { recursive: true, force: true });
  }
}

// Toglie da una revisione in sospeso i campi che non hanno più niente da
// decidere: diventati uguali (ripristinati, modificati a mano, riaggiornati)
// o bloccati nel frattempo. Ritorna true se ha cambiato qualcosa.
function pruneReview(video) {
  const pending = video.pendingReview;
  if (!pending?.fields) return false;
  const locks = new Set(video.locks ?? []);
  let changed = false;
  for (const [field, review] of Object.entries(pending.fields)) {
    const def = META_FIELDS[field];
    let current;
    if (field === 'thumbnail') current = currentThumbnail(video);
    else current = def?.value(video);
    const equal = !def || (def.equal ? def.equal(current, review.incoming) : JSON.stringify(current ?? null) === JSON.stringify(review.incoming ?? null));
    if (equal || locks.has(field)) {
      if (field === 'thumbnail' && review.incoming?.file && review.incoming.file !== video.thumbnail?.localPath) {
        try { unlinkSync(thumbAbs(review.incoming.file)); } catch { /* già sparita */ }
      }
      delete pending.fields[field];
      changed = true;
    }
  }
  if (changed && Object.keys(pending.fields).length === 0) video.pendingReview = null;
  return changed;
}

/** I video con differenze da decidere (le scelte "Chiedimi se diverso"). */
export async function listPendingReviews() {
  const catalog = await readCatalog();
  const stale = Object.values(catalog.videos).filter((v) => v.pendingReview).map((v) => v.id);
  if (stale.length) {
    await updateCatalog((cat) => {
      for (const id of stale) if (cat.videos[id]) pruneReview(cat.videos[id]);
    });
  }
  const fresh = await readCatalog();
  return Object.values(fresh.videos).filter((v) => v.pendingReview && Object.keys(v.pendingReview.fields ?? {}).length);
}

/**
 * Decide una revisione. choices: { campo: 'current' | 'incoming' } (i campi
 * non indicati restano come sono); lock: campi da bloccare insieme.
 */
export async function resolveReview(videoId, { choices = {}, lock = [] } = {}) {
  const catalog = await readCatalog();
  const video = catalog.videos[videoId];
  if (!video?.pendingReview) throw new Error('Questo video non ha differenze da rivedere.');
  const pending = video.pendingReview;

  // Copertina scelta: quella attuale va nello storico, la nuova prende il suo posto.
  let thumbChange = null;
  const tReview = pending.fields.thumbnail;
  if (tReview && choices.thumbnail === 'incoming') {
    const cur = currentThumbnail(video);
    const dest = cur?.file ?? `${videoId}.jpg`;
    let from = null;
    if (cur) {
      const prev = siblingName(cur.file, videoId, `prima-${Date.now()}`);
      await moveFile(thumbAbs(cur.file), thumbAbs(prev));
      from = { file: prev, sha: cur.sha };
    }
    await moveFile(thumbAbs(tReview.incoming.file), thumbAbs(dest));
    thumbChange = { from, to: { file: dest, sha: tReview.incoming.sha } };
  }

  return updateCatalog((cat) => {
    const cur = cat.videos[videoId];
    const entries = [];
    for (const [field, review] of Object.entries(pending.fields)) {
      const choice = choices[field];
      if (field === 'thumbnail') {
        if (thumbChange) {
          META_FIELDS.thumbnail.apply(cur, thumbChange.to);
          entries.push(historyEntry('thumbnail', thumbChange.from, thumbChange.to, 'review', pending.label));
        } else if (choice === 'current') {
          // Tenuta l'attuale: la nuova resta nello storico, consultabile.
          entries.push({ ...historyEntry('thumbnail', review.current, review.incoming, 'kept', pending.label) });
        }
        continue;
      }
      if (choice === 'incoming') {
        META_FIELDS[field].apply(cur, review.incoming);
        entries.push(historyEntry(field, review.current, review.incoming, 'review', pending.label));
      }
    }
    pushHistory(cur, entries);
    const locks = new Set(cur.locks ?? []);
    for (const f of lock) if (META_FIELDS[f]) locks.add(f);
    cur.locks = [...locks];
    const left = Object.fromEntries(Object.entries(pending.fields).filter(([f]) => !(f in choices)));
    cur.pendingReview = Object.keys(left).length ? { ...pending, fields: left } : null;
    cur.updatedAt = new Date().toISOString();
    return cur;
  });
}

/** Modifica a mano di un campo: finisce nella cronologia e il campo si blocca da solo (come in Calibre). */
export async function setVideoField(videoId, field, value) {
  if (!EDITABLE_FIELDS.includes(field)) throw new Error(`Campo non modificabile: ${field}`);
  let clean = value;
  if (field === 'tags') clean = (Array.isArray(value) ? value : String(value ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean);
  else if (field === 'uploadDate') {
    clean = value ? String(value).slice(0, 10) : null;
    if (clean && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw new Error('Data non valida: usa AAAA-MM-GG.');
  } else clean = typeof value === 'string' ? value.trim() : value;
  if (field === 'title' && !clean) throw new Error('Il titolo non può essere vuoto.');
  return updateCatalog((cat) => {
    const v = cat.videos[videoId];
    if (!v) throw new Error(`Video non trovato nel catalogo: ${videoId}`);
    const from = META_FIELDS[field].value(v);
    META_FIELDS[field].apply(v, clean);
    pushHistory(v, [historyEntry(field, from, clean, 'manual', null)]);
    v.locks = [...new Set([...(v.locks ?? []), field])];
    pruneReview(v);
    v.updatedAt = new Date().toISOString();
    return v;
  });
}

export async function setFieldLock(videoId, field, locked) {
  if (!META_FIELDS[field]) throw new Error(`Campo sconosciuto: ${field}`);
  return updateCatalog((cat) => {
    const v = cat.videos[videoId];
    if (!v) throw new Error(`Video non trovato nel catalogo: ${videoId}`);
    const set = new Set(v.locks ?? []);
    if (locked) set.add(field); else set.delete(field);
    v.locks = [...set];
    pruneReview(v);
    v.updatedAt = new Date().toISOString();
    return v;
  });
}

/** Ripristina il valore precedente di una voce della cronologia (copertine comprese). */
export async function restoreHistoryEntry(videoId, entryId) {
  const catalog = await readCatalog();
  const video = catalog.videos[videoId];
  const entry = video?.metadataHistory?.find((e) => e.id === entryId);
  if (!entry) throw new Error('Voce della cronologia non trovata.');
  // "kept": la copertina rifiutata in revisione → si mette quella (to); le
  // altre voci tornano al valore di prima (from).
  const target = entry.origin === 'kept' ? entry.to : entry.from;
  let thumbChange = null;
  if (entry.field === 'thumbnail') {
    if (!target?.file || !existsSync(thumbAbs(target.file))) throw new Error('Quell\'immagine non è più su disco.');
    const cur = currentThumbnail(video);
    const dest = cur?.file ?? `${videoId}.jpg`;
    let from = null;
    if (cur) {
      const prev = siblingName(cur.file, videoId, `prima-${Date.now()}`);
      await moveFile(thumbAbs(cur.file), thumbAbs(prev));
      from = { file: prev, sha: cur.sha };
    }
    await moveFile(thumbAbs(target.file), thumbAbs(dest));
    thumbChange = { from, to: { file: dest, sha: target.sha } };
  }
  return updateCatalog((cat) => {
    const v = cat.videos[videoId];
    if (entry.field === 'thumbnail') {
      META_FIELDS.thumbnail.apply(v, thumbChange.to);
      pushHistory(v, [historyEntry('thumbnail', thumbChange.from, thumbChange.to, 'restore', null)]);
    } else {
      const from = META_FIELDS[entry.field].value(v);
      META_FIELDS[entry.field].apply(v, target);
      pushHistory(v, [historyEntry(entry.field, from, target, 'restore', null)]);
    }
    pruneReview(v);
    v.updatedAt = new Date().toISOString();
    return v;
  });
}
