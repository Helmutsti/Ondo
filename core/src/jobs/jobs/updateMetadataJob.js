import { readCatalog } from '../../catalog/catalogStore.js';
import { shouldStopRun } from '../../ytdlp/errorClassifier.js';
import { updateVideoMetadata } from '../../services/metadataUpdateService.js';
import { FIELD_NAMES, META_FIELDS } from '../../services/metadataFields.js';

const names = (fields) => fields.map((f) => (META_FIELDS[f]?.label ?? f).toLowerCase()).join(', ');

// Il wizard "Aggiorna metadati" (redesign R4): un job per richiesta, con i
// video, i campi e le regole scelti. Gira in background (si può chiudere la
// finestra) e lascia nella nota del job i conteggi dal vivo e gli ultimi
// video elaborati, che il wizard e l'Attività mostrano.
//
// Più video insieme (CONCURRENCY), ma mai una raffica di errori: un blocco di
// YouTube o un problema della macchina fermano il job alla prima occorrenza,
// e i video non ancora toccati restano esattamente com'erano.
export const CONCURRENCY = 3;
const RECENT = 8;

const OUTCOME_TEXT = {
  updated: 'aggiornato',
  unchanged: 'invariato',
  review: 'da rivedere',
  removed: 'sparito da YouTube',
  restricted: 'accesso limitato',
  error: 'non recuperato'
};

export async function updateMetadataJob({ videoIds = [], fields = FIELD_NAMES, rules = {}, label = null } = {}, { log, progress, note }) {
  const catalog = await readCatalog();
  const ids = videoIds.filter((id) => catalog.videos[id]);
  const counts = { total: ids.length, done: 0, updated: 0, unchanged: 0, review: 0, removed: 0, restricted: 0, error: 0 };
  const recent = [];
  let stopped = null;
  note?.({ label, counts, recent });
  log(`${ids.length} video da aggiornare · campi: ${fields.join(', ')}.`);

  let next = 0;
  async function worker() {
    while (!stopped && next < ids.length) {
      const id = ids[next++];
      const title = catalog.videos[id]?.title ?? id;
      let r;
      try {
        r = await updateVideoMetadata(id, { fields, rules, label });
      } catch (err) {
        r = { outcome: 'error', applied: [], review: [], locked: [], classification: { hint: err.message, message: err.message } };
      }
      if (r.outcome === 'stop') {
        stopped = r.classification;
        log(`■ Interrotto: ${r.classification.hint} (${r.classification.message}). I video non ancora elaborati restano com'erano.`);
        break;
      }
      if (r.classification && shouldStopRun(r.classification)) { stopped = r.classification; break; }
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
      progress(Math.round((counts.done / Math.max(ids.length, 1)) * 100));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length || 1) }, worker));

  log(`Fatto: ${counts.updated} aggiornati, ${counts.unchanged} invariati, ${counts.review} da rivedere, ${counts.removed} spariti, ${counts.error} non recuperati.`);
  const summary = { ...counts, label };
  if (stopped) {
    const err = new Error(stopped.hint);
    err.classification = stopped;
    err.summary = summary;
    throw err;
  }
  return summary;
}
