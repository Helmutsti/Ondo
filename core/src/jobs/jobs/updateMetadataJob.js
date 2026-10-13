import { readCatalog } from '../../catalog/catalogStore.js';
import { shouldStopRun } from '../../ytdlp/errorClassifier.js';
import { getMetadataParallelism } from '../jobManager.js';
import { getBlock, noteBlocked, noteUnblocked } from '../../services/blockState.js';
import { updateVideoMetadata } from '../../services/metadataUpdateService.js';
import { FIELD_NAMES, META_FIELDS } from '../../services/metadataFields.js';

const names = (fields) => fields.map((f) => (META_FIELDS[f]?.label ?? f).toLowerCase()).join(', ');

// Il wizard "Aggiorna metadati" (redesign R4): un job per richiesta, con i
// video, i campi e le regole scelti. Gira in background (si può chiudere la
// finestra) e lascia nella nota del job i conteggi dal vivo e gli ultimi
// video elaborati, che il wizard e l'Attività mostrano.
//
// Più video insieme (quanti "Metadati in parallelo"), ma mai una raffica di
// errori: un blocco di YouTube mette in PAUSA il recupero con attesa
// crescente (15 min, 30, 60…) e poi riprova lo stesso video; dopo
// MAX_PAUSES pause di fila si arrende. Un problema della macchina lo ferma
// subito. I video non ancora toccati restano esattamente com'erano, e quelli
// fatti sono salvati: dopo un riavvio il job riparte dai rimasti.
const MAX_PAUSES = 4;
const RECENT = 8;

const OUTCOME_TEXT = {
  updated: 'aggiornato',
  unchanged: 'invariato',
  review: 'da rivedere',
  removed: 'sparito da YouTube',
  restricted: 'accesso limitato',
  error: 'non recuperato'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function updateMetadataJob({ videoIds = [], fields = FIELD_NAMES, rules = {}, label = null, resumedFrom = null } = {}, { log, progress, note, checkpoint }) {
  const catalog = await readCatalog();
  const ids = videoIds.filter((id) => catalog.videos[id]);
  const counts = { total: ids.length, done: 0, updated: 0, unchanged: 0, review: 0, removed: 0, restricted: 0, error: 0 };
  const recent = [];
  let stopped = null;
  note?.({ label, counts, recent });
  log(`${resumedFrom ? 'Ripreso dopo un riavvio: ' : ''}${ids.length} video da aggiornare · campi: ${fields.join(', ')}.`);
  const doneIds = [];
  let pauses = 0;

  // Pausa condivisa da tutti i lavoratori: il primo che incontra il blocco la
  // decide, gli altri aspettano la stessa scadenza.
  async function waitBlock() {
    const b = getBlock();
    if (!b) return;
    note?.({ pausedUntil: b.until, pauseHint: b.hint });
    while (getBlock()) await sleep(5000);
    note?.({ pausedUntil: null, pauseHint: null });
  }

  let next = 0;
  async function worker() {
    while (!stopped && next < ids.length) {
      await waitBlock();
      if (stopped) break;
      const id = ids[next++];
      const title = catalog.videos[id]?.title ?? id;
      let r;
      try {
        r = await updateVideoMetadata(id, { fields, rules, label });
      } catch (err) {
        r = { outcome: 'error', applied: [], review: [], locked: [], classification: { hint: err.message, message: err.message } };
      }
      const c = r.classification;
      if ((r.outcome === 'stop' || (c && shouldStopRun(c))) && c?.category === 'blocked' && pauses < MAX_PAUSES) {
        // Bloccati da YouTube: pausa con attesa crescente, poi si riprova
        // questo stesso video.
        pauses += 1;
        const b = getBlock() ?? noteBlocked(c);
        log(`⏸ YouTube sta bloccando le richieste: pausa fino alle ${new Date(b.until).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}, poi riprendo.`);
        ids.push(id);
        continue;
      }
      if (r.outcome === 'stop' || (c && shouldStopRun(c))) {
        stopped = c;
        log(`■ Interrotto: ${c.hint} (${c.message}). I video non ancora elaborati restano com'erano.`);
        break;
      }
      if (r.outcome !== 'error') { pauses = 0; noteUnblocked(); }
      doneIds.push(id);
      checkpoint?.({ doneIds });
      counts.done += 1;
      counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
      let detail = OUTCOME_TEXT[r.outcome] ?? r.outcome;
      if (r.applied.length) detail = `aggiornati: ${names(r.applied)}`;
      if (r.review.length) detail = `diversi, da rivedere: ${names(r.review)}`;
      if (r.locked.length) detail += ` · bloccati, saltati: ${names(r.locked)}`;
      if (r.outcome === 'error' || r.outcome === 'removed' || r.outcome === 'restricted') detail = `${OUTCOME_TEXT[r.outcome]}: ${r.classification?.hint ?? ''}`;
      recent.unshift({ id, title, outcome: r.outcome, detail });
      recent.length = Math.min(recent.length, RECENT);
      log(`${r.outcome === 'error' ? '✘' : '✔'} ${title}: ${detail}`);
      note?.({ counts: { ...counts }, recent: [...recent] });
      progress(Math.round((counts.done / Math.max(counts.total, 1)) * 100));
    }
  }
  await Promise.all(Array.from({ length: Math.min(getMetadataParallelism(), ids.length || 1) }, worker));

  log(`Fatto: ${counts.updated} aggiornati, ${counts.unchanged} invariati, ${counts.review} da rivedere, ${counts.removed} spariti, ${counts.error} non recuperati.`);
  const summary = { ...counts, label };
  if (stopped) {
    const err = new Error(stopped.hint);
    err.blockNoted = true;
    err.classification = stopped;
    err.summary = summary;
    throw err;
  }
  return summary;
}
