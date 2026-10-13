import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
import { PRESENCE, DOWNLOAD_STATE } from '../../catalog/catalogSchema.js';
import { fetchVideoMetadata } from '../../ytdlp/ytdlpWrapper.js';
import { classifyYtdlpError, errorRecord, shouldStopRun } from '../../ytdlp/errorClassifier.js';
import { syncChannelAvatars } from '../../services/channelAvatarService.js';
import { applyRemoteVerdict, checkVideoPresence, needsPresenceCheck } from '../../services/presenceService.js';

// Errori di fila con la stessa categoria dopo cui l'esecuzione si ferma: se
// cinque video consecutivi falliscono per lo stesso motivo, il motivo non è il
// singolo video e continuare riempirebbe la libreria di errori uguali.
export const SAME_ERROR_STREAK_LIMIT = 5;

// Interruttore di sicurezza condiviso dalle due fasi.
function createBreaker(log) {
  let streakCategory = null;
  let streak = 0;
  return {
    stopped: null,
    success() { streakCategory = null; streak = 0; },
    // true se l'esecuzione deve fermarsi dopo questo errore
    failure(classification) {
      if (shouldStopRun(classification)) {
        this.stopped = classification;
        log(`■ Interrotto: ${classification.hint} (${classification.message}). Nessuno stato è stato cambiato per questo motivo.`);
        return true;
      }
      if (classification.category === streakCategory) streak += 1;
      else { streakCategory = classification.category; streak = 1; }
      if (streak >= SAME_ERROR_STREAK_LIMIT) {
        this.stopped = classification;
        log(`■ Interrotto: ${streak} errori di fila dello stesso tipo (${classification.category}): ${classification.hint}`);
        return true;
      }
      return false;
    }
  };
}

// Dopo addSource/syncSource (metadati LEGGERI dell'elenco, istantanei), questo
// job fa due cose, nell'ordine:
//
// 1. Verifica di presenza dei video che la sync ha segnalato (usciti dalla
//    fonte, voci segnaposto, rimossi che ricompaiono) e dei "rimossi" della
//    logica precedente mai ricontrollati. È l'unico modo in cui la presenza
//    cambia (vedi presenceService).
// 2. Arricchimento: metadati COMPLETI (descrizione, tag, capitoli, risoluzione,
//    statistiche) e copertina in locale per i video non ancora arricchiti —
//    una chiamata yt-dlp per video, senza scaricare il video. Idempotente.
//
// params.sourceId: se presente, lavora solo sui video di quella fonte.
export async function enrichSourceJob(params, { log, progress }) {
  const { sourceId } = params ?? {};
  const catalog = await readCatalog();
  const inScope = (v) => !sourceId || v.sources?.some((s) => s.sourceId === sourceId);

  const toVerify = Object.values(catalog.videos).filter((v) => inScope(v) && needsPresenceCheck(v));
  const toEnrich = Object.values(catalog.videos).filter((v) =>
    inScope(v)
    && v.presence === PRESENCE.PRESENT
    && !needsPresenceCheck(v)
    && v.download !== DOWNLOAD_STATE.DOWNLOADED
    && v.download !== DOWNLOAD_STATE.DOWNLOADING
    && !v.enrichedAt
  );
  const total = toVerify.length + toEnrich.length;
  let done = 0;
  const step = () => { done += 1; progress(Math.round((done / Math.max(total, 1)) * 100)); };
  const breaker = createBreaker(log);
  const verified = { present: 0, restored: 0, removed: 0, confirmed: 0, strike: 0, restricted: 0, unchanged: 0 };

  // --- 1. Verifica di presenza
  if (toVerify.length > 0) {
    log(`${toVerify.length} video da verificare su YouTube (usciti dalla fonte o con stato da confermare).`);
    for (const video of toVerify) {
      if (breaker.stopped) break;
      const { outcome, classification } = await checkVideoPresence(video.id);
      step();
      if (outcome === 'stop') { breaker.failure(classification); break; }
      verified[outcome] = (verified[outcome] ?? 0) + 1;
      if (classification && outcome === 'unchanged') breaker.failure(classification);
      else breaker.success();
      const label = video.title ?? video.id;
      if (outcome === 'removed') log(`⊘ ${label}: ${classification.hint}`);
      else if (outcome === 'confirmed') log(`⊘ ${label}: confermato — ${classification.hint}`);
      else if (outcome === 'restored') log(`↺ ${label}: è di nuovo disponibile.`);
      else if (outcome === 'strike') log(`? ${label}: YouTube lo dà non disponibile, lo ricontrollerò più avanti prima di decidere.`);
      else if (outcome === 'restricted') log(`◐ ${label}: ${classification.hint}`);
      else if (outcome === 'unchanged') log(`✘ ${label}: verifica non riuscita, stato invariato — ${classification.hint}`);
    }
    log(`Verifica: ${verified.present} presenti, ${verified.restored} tornati disponibili, ${verified.removed} spariti, ${verified.confirmed} confermati spariti, ${verified.strike} da riconfermare, ${verified.restricted} ad accesso limitato, ${verified.unchanged} non verificati.`);
  }

  // --- 2. Arricchimento
  let enriched = 0;
  let failed = 0;
  let removed = 0;
  if (breaker.stopped) {
    log('Arricchimento saltato: stesso motivo dell\'interruzione.');
  } else if (toEnrich.length === 0) {
    log('Nessun video da arricchire (già completi o già arricchiti).');
  } else {
    log(`${toEnrich.length} video da arricchire (metadati completi + copertina).`);
    for (let i = 0; i < toEnrich.length; i++) {
      const video = toEnrich[i];
      log(`--- (${i + 1}/${toEnrich.length}) ${video.id}: ${video.title ?? '(titolo sconosciuto)'} ---`);
      try {
        const fields = await fetchVideoMetadata(video.id, video.webpageUrl, { onLog: log });
        // Scarta l'oggetto `video` (nessun file scaricato): l'arricchimento tocca
        // solo i metadati e la copertina, mai lo stato di download.
        const { video: _ignore, ...meta } = fields;
        await updateCatalog((cat) => {
          const current = cat.videos[video.id];
          if (!current) return; // rimosso nel frattempo
          Object.assign(current, meta, {
            enrichedAt: new Date().toISOString(),
            enrichError: null,
            updatedAt: new Date().toISOString()
          });
        });
        enriched += 1;
        breaker.success();
        log(`✔ ${video.id} arricchito.`);
      } catch (err) {
        const classification = classifyYtdlpError(err);
        if (shouldStopRun(classification)) { breaker.failure(classification); step(); break; }
        const outcome = await updateCatalog((cat) => {
          const current = cat.videos[video.id];
          if (!current) return null;
          const attempts = (current.enrichError?.attempts ?? 0) + 1;
          current.enrichError = errorRecord(classification, { attempts });
          current.updatedAt = new Date().toISOString();
          return applyRemoteVerdict(current, classification, { isCheck: false }).outcome;
        });
        if (outcome === 'removed') {
          removed += 1;
          log(`⊘ ${video.id}: ${classification.hint}`);
        } else {
          failed += 1;
          log(`✘ ${video.id} non arricchito [${classification.category}]: ${classification.hint} — ${classification.message}`);
        }
        // Un video sparito, ad accesso limitato o da riconfermare è una
        // risposta sul video, non un guasto: non conta per l'interruttore.
        if (outcome !== 'unchanged') breaker.success();
        else if (breaker.failure(classification)) { step(); break; }
      }
      step();
    }
    log(`Arricchimento: ${enriched} arricchiti, ${failed} falliti${removed ? `, ${removed} spariti da YouTube` : ''}.`);
  }

  progress(100);

  // Foto profilo dei creator (M14): a fine sync scarica quelle mancanti, così un
  // creator appena aggiunto ottiene l'avatar senza un'azione manuale separata
  // (force:false → salta i creator che ce l'hanno già). Non blocca il job.
  if (!breaker.stopped) {
    try {
      log('Aggiornamento foto profilo dei creator…');
      const a = await syncChannelAvatars({ force: false });
      log(`Foto creator: ${a.fetchedCount} scaricate, ${a.skippedCount} già presenti${a.failedCount ? `, ${a.failedCount} non trovate` : ''}.`);
    } catch (err) {
      log(`Foto creator non aggiornate: ${err.message}`);
    }
  }

  const summary = { verified, enriched, failed, removed, total: toEnrich.length };
  if (breaker.stopped) {
    // Il job finisce in errore con il motivo vero: la Cronologia mostra
    // "YouTube chiede di confermare che non sei un bot", non 300 errori.
    const err = new Error(breaker.stopped.hint);
    err.classification = breaker.stopped;
    err.summary = summary;
    throw err;
  }
  return summary;
}
