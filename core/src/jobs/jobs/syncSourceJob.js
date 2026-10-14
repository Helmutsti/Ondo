import { readCatalog } from '../../catalog/catalogStore.js';
import { DOWNLOAD_STATE, PRESENCE } from '../../catalog/catalogSchema.js';
import { syncSource } from '../../services/syncService.js';
import { recordSourceCheck, queueDownloads } from '../../services/sourceService.js';
import { rulesOf } from '../../services/sourceRules.js';
import { classifyYtdlpError, errorRecord } from '../../ytdlp/errorClassifier.js';
import { enrichSourceJob } from './enrichSource.js';
import { noteUnblocked } from '../../services/blockState.js';

// Controllo di UNA fonte (redesign R3): lo lancia "Sincronizza" e lo lancia lo
// scheduler quando la fonte è scaduta. In ordine:
//   1. elenco leggero della playlist (syncSource): video nuovi, usciti, sospetti;
//   2. verifica di presenza e arricchimento dei soli video di questa fonte
//      (enrichSource): i metadati dei video già arricchiti non si toccano;
//   3. se la fonte ha lo scaricamento automatico, un download per ciascun
//      video ENTRATO con questo controllo, alla qualità della fonte.
// L'esito (o l'errore classificato) resta sulla fonte: la pagina Fonti lo
// mostra senza dover cercare nello storico dei job.
export async function syncSourceJob({ sourceId, auto = false }, ctx) {
  const { log, progress, note } = ctx;
  if (!sourceId) throw new Error('syncSource richiede il parametro "sourceId"');
  const catalog = await readCatalog();
  const source = catalog.sources[sourceId];
  if (!source) throw new Error(`Fonte non trovata: "${sourceId}"`);
  note?.({ sourceId, sourceName: source.name, phase: 'enumerating', auto });
  log(`${auto ? 'Controllo automatico' : 'Controllo'} di "${source.name}"…`);

  let r;
  try {
    r = await syncSource(sourceId);
  } catch (err) {
    const classification = err.classification ?? classifyYtdlpError(err);
    await recordSourceCheck(sourceId, { error: errorRecord(classification) });
    log(`✘ Elenco non letto [${classification.category}]: ${classification.hint}`);
    const wrapped = new Error(`"${source.name}": ${classification.hint}`);
    wrapped.classification = classification;
    throw wrapped;
  }

  // L'elenco è arrivato: YouTube risponde di nuovo, niente più attesa crescente.
  noteUnblocked();
  const parts = [`${r.newCount} nuovi`];
  if (r.leftCount) parts.push(`${r.leftCount} usciti dalla playlist`);
  if (r.rejoinedCount) parts.push(`${r.rejoinedCount} rientrati`);
  if (r.toVerifyCount) parts.push(`${r.toVerifyCount} da verificare`);
  log(`Elenco letto: ${parts.join(', ')}.`);
  if (r.suspect) log(`⚠ Elenco anomalo (${r.suspect.count} video invece di ${r.suspect.lastGoodCount ?? '?'}): nessun video segnato come uscito.`);

  note?.({ phase: 'enriching' });
  let enrich = null;
  let enrichError = null;
  try {
    enrich = await enrichSourceJob({ sourceId }, { ...ctx, progress });
  } catch (err) {
    // La fonte è stata letta: l'errore è della verifica/arricchimento (blocco
    // di YouTube, ambiente). Si registra e si rilancia per dire perché.
    enrichError = err;
  }

  // Scaricamento automatico: solo i video arrivati ORA e ancora su YouTube
  // (nascosti compresi: nascondere toglie solo dalla vista). La qualità è
  // quella della fonte, senza domande.
  const rules = rulesOf((await readCatalog()).sources[sourceId]);
  let autoQueued = 0;
  if (rules.autoDownload && r.newIds?.length) {
    const fresh = await readCatalog();
    const ids = r.newIds.filter((id) => {
      const v = fresh.videos[id];
      return v && v.presence === PRESENCE.PRESENT && v.download === DOWNLOAD_STATE.NONE;
    });
    autoQueued = queueDownloads(ids, rules);
    if (autoQueued) log(`↓ ${autoQueued} video nuovi in coda per il download automatico.`);
  }

  const result = {
    newCount: r.newCount,
    leftCount: r.leftCount,
    rejoinedCount: r.rejoinedCount,
    toVerifyCount: r.toVerifyCount,
    suspect: r.suspect ?? null,
    removed: enrich?.verified ? (enrich.verified.removed ?? 0) : 0,
    restored: enrich?.verified ? (enrich.verified.restored ?? 0) : 0,
    autoQueued
  };
  const classification = enrichError ? (enrichError.classification ?? classifyYtdlpError(enrichError)) : null;
  await recordSourceCheck(sourceId, { result, error: classification ? errorRecord(classification) : null });
  if (enrichError) throw enrichError;
  progress(100);
  return result;
}
