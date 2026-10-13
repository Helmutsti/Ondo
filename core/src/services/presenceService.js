import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { PRESENCE, DOWNLOAD_STATE } from '../catalog/catalogSchema.js';
import { resolveVideoInfo } from '../ytdlp/ytdlpWrapper.js';
import { ERROR_CATEGORY, classifyYtdlpError, errorRecord } from '../ytdlp/errorClassifier.js';

// Presenza su YouTube: l'UNICO posto che la cambia.
//
// Regola: un video diventa "rimosso" solo se yt-dlp lo dice per QUEL video, e
// in modo esplicito (privato, rimosso con un motivo). "Video unavailable" senza
// spiegazione serve confermarlo più volte a distanza di ore. L'assenza da una
// playlist, la rete, i blocchi di YouTube e gli errori sconosciuti non toccano
// mai la presenza: al massimo chiedono un nuovo controllo.

// "Video unavailable" generico: quante conferme, e a che distanza minima, prima
// di considerarlo sparito. Due controlli nello stesso minuto possono cadere
// nello stesso momento storto di YouTube; a sei ore di distanza no.
export const UNAVAILABLE_CONFIRMATIONS = 2;
export const UNAVAILABLE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Controlli falliti per motivi che non riguardano la presenza (rete, errori
// sconosciuti…) dopo i quali si smette di riprovare, lasciando lo stato com'era.
export const MAX_CHECK_ATTEMPTS = 5;

const C = ERROR_CATEGORY;

function markRemoved(video, reason, nowIso) {
  const wasRemoved = video.presence === PRESENCE.REMOVED;
  video.presence = PRESENCE.REMOVED;
  video.removedAt = wasRemoved && video.removedAt ? video.removedAt : nowIso;
  video.removedReason = reason;
  video.presenceCheckPending = false;
  // Già rimosso e riconfermato da YouTube: è una risposta, non un controllo
  // fallito (prima finiva tra i "non verificati" e pesava sull'interruttore).
  return wasRemoved ? 'confirmed' : 'removed';
}

function markPresent(video) {
  const wasRemoved = video.presence === PRESENCE.REMOVED;
  video.presence = PRESENCE.PRESENT;
  video.removedAt = null;
  video.removedReason = null;
  video.missCount = 0;
  return wasRemoved ? 'restored' : 'present';
}

/**
 * Applica a un video (in memoria) l'esito di una richiesta a YouTube.
 * Funzione pura sul solo oggetto: niente I/O, così è verificabile nei test.
 *
 * @param video           l'oggetto video del catalogo (viene modificato)
 * @param classification  null se il video ha risposto, altrimenti l'esito di classifyYtdlpError
 * @param options.isCheck true per un controllo di presenza (conta i tentativi
 *                        falliti); false per download/metadati, dove un errore
 *                        di rete non è un controllo mancato
 * @returns {{ outcome: string }} present | restored | removed | confirmed | strike | restricted | stop | unchanged
 */
export function applyRemoteVerdict(video, classification, { isCheck = true, now = new Date() } = {}) {
  const nowIso = now.toISOString();

  if (!classification) {
    const outcome = markPresent(video);
    video.access = null;
    video.goneStrikes = 0;
    video.lastGoneStrikeAt = null;
    video.presenceCheckPending = false;
    video.presenceCheckAttempts = 0;
    video.presenceCheckError = null;
    video.presenceCheckedAt = nowIso;
    return { outcome };
  }

  const { category, reason } = classification;

  if (category === C.REMOVED || category === C.PRIVATE) {
    const outcome = markRemoved(video, category === C.PRIVATE ? 'private' : reason, nowIso);
    video.presenceCheckedAt = nowIso;
    video.presenceCheckError = null;
    return { outcome };
  }

  if (category === C.UNAVAILABLE) {
    const last = video.lastGoneStrikeAt ? Date.parse(video.lastGoneStrikeAt) : null;
    // Una seconda risposta "unavailable" troppo vicina alla prima non conta:
    // potrebbe essere lo stesso momento storto.
    if (last === null || now.getTime() - last >= UNAVAILABLE_MIN_INTERVAL_MS) {
      video.goneStrikes = (video.goneStrikes ?? 0) + 1;
      video.lastGoneStrikeAt = nowIso;
    }
    video.presenceCheckedAt = nowIso;
    video.presenceCheckError = errorRecord(classification);
    if (video.goneStrikes >= UNAVAILABLE_CONFIRMATIONS) {
      return { outcome: markRemoved(video, 'unavailable', nowIso) };
    }
    // Da ricontrollare più avanti: è il prossimo controllo a decidere.
    video.presenceCheckPending = true;
    return { outcome: 'strike' };
  }

  if (category === C.RESTRICTED) {
    // Il video esiste: se era segnato rimosso, non lo è.
    markPresent(video);
    video.access = { reason, hint: classification.hint, message: classification.message, checkedAt: nowIso };
    video.goneStrikes = 0;
    video.lastGoneStrikeAt = null;
    video.presenceCheckPending = false;
    video.presenceCheckedAt = nowIso;
    video.presenceCheckError = null;
    return { outcome: 'restricted' };
  }

  // Blocchi di YouTube o problemi della macchina: non dicono nulla del video.
  // Chi esegue deve fermarsi; il video resta esattamente com'era.
  if (category === C.BLOCKED || category === C.ENVIRONMENT) {
    return { outcome: 'stop' };
  }

  // Rete, formati, errori interni o sconosciuti: nessun cambio di presenza.
  if (isCheck) {
    video.presenceCheckAttempts = (video.presenceCheckAttempts ?? 0) + 1;
    video.presenceCheckError = errorRecord(classification, { attempts: video.presenceCheckAttempts });
    if (video.presenceCheckAttempts >= MAX_CHECK_ATTEMPTS) video.presenceCheckPending = false;
  }
  return { outcome: 'unchanged' };
}

/** Come applyRemoteVerdict, ma sul catalogo salvato. */
export async function recordRemoteVerdict(id, classification, options = {}) {
  return updateCatalog((catalog) => {
    const video = catalog.videos[id];
    if (!video) return null;
    const result = applyRemoteVerdict(video, classification, options);
    if (result.outcome !== 'stop') video.updatedAt = new Date().toISOString();
    return result;
  });
}

// Il video ha bisogno di un controllo di presenza: chiesto dalla sync, oppure
// segnato "rimosso" dalla logica di prima (senza motivo registrato) e mai
// ricontrollato — quelli possono essere falsi positivi da verificare una volta.
export function needsPresenceCheck(video) {
  if (video.presenceCheckPending) return true;
  return video.presence === PRESENCE.REMOVED && !video.removedReason && !video.presenceCheckedAt;
}

/**
 * Chiede a YouTube se un singolo video esiste ancora e ne aggiorna lo stato.
 * @returns {{ outcome: string, classification: object|null }}
 */
export async function checkVideoPresence(id) {
  const catalog = await readCatalog();
  const video = catalog.videos[id];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
  const url = video.webpageUrl ?? `https://www.youtube.com/watch?v=${id}`;
  try {
    await resolveVideoInfo(url);
    const result = await recordRemoteVerdict(id, null);
    return { ...result, classification: null };
  } catch (err) {
    const classification = classifyYtdlpError(err);
    const result = await recordRemoteVerdict(id, classification);
    return { ...result, classification };
  }
}

/**
 * Download fallito: stato "failed" con il motivo classificato (categoria,
 * spiegazione, messaggio di yt-dlp, tentativi) e, se l'errore parla della
 * presenza del video, la presenza aggiornata con le stesse regole di sempre.
 * @returns {{ classification: object, outcome: string|null }}
 */
export async function recordDownloadFailure(id, err) {
  const classification = classifyYtdlpError(err);
  const outcome = await updateCatalog((catalog) => {
    const video = catalog.videos[id];
    if (!video) return null;
    video.download = DOWNLOAD_STATE.FAILED;
    video.attempts = (video.attempts ?? 0) + 1;
    video.error = errorRecord(classification, { attempts: video.attempts });
    video.updatedAt = new Date().toISOString();
    return applyRemoteVerdict(video, classification, { isCheck: false }).outcome;
  });
  return { classification, outcome };
}

/** Segna un video come rimosso per un motivo esplicito. */
export async function markVideoRemoved(id, reason = 'removed') {
  return recordRemoteVerdict(
    id,
    { category: reason === 'private' ? C.PRIVATE : C.REMOVED, reason, hint: '', message: '' },
    { isCheck: false }
  );
}
