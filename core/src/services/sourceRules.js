// Regole per fonte (redesign R3): ogni quanto controllarla, se scaricare da
// sola i video nuovi e a che qualità. Modulo puro: la forma, i default e i
// calcoli sulle date, senza I/O.
//
//   source.rules = { checkEvery, autoDownload, quality }
//     checkEvery:   null (mai) | '1h' | '6h' | '12h' | '24h'
//     autoDownload: false di default — la scrematura resta dell'utente;
//                   si accende per le playlist usate come "da scaricare"
//     quality:      null = la qualità predefinita | { kind: 'best' } | { kind: 'height', height }
//   più, scritti dal controllo: lastCheckedAt, nextCheckAt, lastError, lastResult.

export const CHECK_INTERVALS = { '1h': 1, '6h': 6, '12h': 12, '24h': 24 };

// Le fonti che esistevano prima delle regole si controllano ogni 6 ore: è
// quello che serve anche alla seconda conferma (a ≥6 h) dei video
// "non disponibili".
export const DEFAULT_RULES = Object.freeze({ checkEvery: '6h', autoDownload: false, quality: null });

export function rulesOf(source) {
  const r = source?.rules ?? {};
  return {
    checkEvery: r.checkEvery === null ? null : (CHECK_INTERVALS[r.checkEvery] ? r.checkEvery : DEFAULT_RULES.checkEvery),
    autoDownload: r.autoDownload === true,
    quality: normalizeQuality(r.quality)
  };
}

export function normalizeQuality(q) {
  if (!q || typeof q !== 'object') return null;
  if (q.kind === 'best') return { kind: 'best' };
  const h = Number(q.height);
  if (q.kind === 'height' && Number.isFinite(h) && h > 0) return { kind: 'height', height: h };
  return null;
}

/** Valida le regole in ingresso (dall'API). Lancia con un messaggio leggibile. */
export function validateRules(input = {}) {
  const out = {};
  if ('checkEvery' in input) {
    if (input.checkEvery !== null && !CHECK_INTERVALS[input.checkEvery]) {
      throw new Error(`Frequenza non valida: usa ${Object.keys(CHECK_INTERVALS).join(', ')} oppure null (mai).`);
    }
    out.checkEvery = input.checkEvery;
  }
  if ('autoDownload' in input) out.autoDownload = input.autoDownload === true;
  if ('quality' in input) out.quality = normalizeQuality(input.quality);
  return out;
}

/** Quando va fatto il prossimo controllo (ISO), o null se la fonte non si controlla da sola. */
export function nextCheckFrom(rules, fromIso) {
  const hours = CHECK_INTERVALS[rules.checkEvery];
  if (!hours) return null;
  const from = fromIso ? Date.parse(fromIso) : NaN;
  const base = Number.isFinite(from) ? from : Date.now();
  return new Date(base + hours * 3_600_000).toISOString();
}

/** Il tetto di risoluzione da passare al download per questa fonte: undefined = predefinita, null = massima. */
export function maxHeightFor(rules) {
  if (!rules.quality) return undefined;
  if (rules.quality.kind === 'best') return null;
  return rules.quality.height;
}
