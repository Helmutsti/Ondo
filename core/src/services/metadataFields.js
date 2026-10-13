// I campi dei metadati che l'utente controlla (redesign R4, "stile Calibre"),
// e l'UNICA funzione che decide come un valore nuovo arrivato da YouTube si
// unisce a quello salvato. Modulo puro: niente I/O, verificabile nei test.
//
// Per campo, una regola:
//   fill      → riempi solo i vuoti (il default sicuro)
//   overwrite → sovrascrivi
//   ask       → chiedimi se diverso (il campo va in revisione)
// e, sopra a tutto, due garanzie che nessuna regola scavalca:
//   - un campo BLOCCATO (video.locks) non si tocca mai;
//   - un valore pieno non viene MAI sostituito da uno vuoto o da un
//     segnaposto ("Private video", "[Deleted video]").

export const FIELD_RULES = ['fill', 'overwrite', 'ask'];

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Due copertine sono "la stessa" se si somigliano a colpo d'occhio: la
// stessa immagine riconvertita in JPEG non dà mai gli stessi byte, e senza
// questo ogni copertina finirebbe in revisione. `look` è l'immagine ridotta a
// 16×16 in scala di grigi (base64, vedi metadataUpdateService): si confronta
// la differenza media dei pixel.
export const LOOK_TOLERANCE = 6;
export function sameLook(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b, 'base64');
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff += Math.abs(x[i] - y[i]);
  return diff / x.length <= LOOK_TOLERANCE;
}

// value: legge il campo dal video; apply: lo scrive. La copertina ha un valore
// fatto di { file, sha } (vedi metadataUpdateService): due copertine sono
// uguali se l'immagine è la stessa, non se il nome del file coincide.
export const META_FIELDS = {
  title: {
    label: 'Titolo',
    value: (v) => v.title ?? null,
    apply: (v, x) => { v.title = x; }
  },
  description: {
    label: 'Descrizione',
    value: (v) => v.description ?? null,
    apply: (v, x) => { v.description = x; }
  },
  tags: {
    label: 'Tag',
    value: (v) => v.tags ?? [],
    apply: (v, x) => { v.tags = x ?? []; }
  },
  thumbnail: {
    label: 'Copertina',
    value: (v) => (v.thumbnail?.localPath ? { file: v.thumbnail.localPath, sha: v.thumbnail.sha256 ?? null } : null),
    apply: (v, x) => { v.thumbnail = { ...(v.thumbnail ?? {}), localPath: x?.file ?? null, sha256: x?.sha ?? null }; },
    equal: (a, b) => !!a && !!b && ((!!a.sha && a.sha === b.sha) || sameLook(a.look, b.look))
  },
  chapters: {
    label: 'Capitoli',
    value: (v) => v.chapters ?? [],
    apply: (v, x) => { v.chapters = x ?? []; }
  },
  uploadDate: {
    label: 'Data di pubblicazione',
    value: (v) => v.uploadDate ?? null,
    apply: (v, x) => { v.uploadDate = x; }
  },
  durationSeconds: {
    label: 'Durata',
    value: (v) => v.durationSeconds ?? null,
    apply: (v, x) => { v.durationSeconds = x; }
  }
};

export const FIELD_NAMES = Object.keys(META_FIELDS);

// Default delle regole (come nel design): il titolo e la copertina si
// rivedono, la descrizione si riempie solo se manca, i tag si sostituiscono.
export const DEFAULT_FIELD_RULES = Object.freeze({
  title: 'ask', description: 'fill', tags: 'overwrite', thumbnail: 'ask',
  chapters: 'fill', uploadDate: 'fill', durationSeconds: 'fill'
});

// I campi che si possono modificare a mano dal dettaglio del video.
export const EDITABLE_FIELDS = ['title', 'description', 'tags', 'uploadDate'];

const PLACEHOLDER = /^\s*\[?\s*(private|deleted|unavailable)\s+video\s*\]?\s*$/i;

export function isEmptyValue(x) {
  if (x == null) return true;
  if (typeof x === 'string') return x.trim() === '';
  if (Array.isArray(x)) return x.length === 0;
  if (typeof x === 'object' && 'file' in x) return !x.file;
  return false;
}

export function isPlaceholder(field, x) {
  return (field === 'title' || field === 'description') && typeof x === 'string' && PLACEHOLDER.test(x);
}

export function normalizeRules(rules = {}) {
  const out = {};
  for (const f of FIELD_NAMES) out[f] = FIELD_RULES.includes(rules[f]) ? rules[f] : DEFAULT_FIELD_RULES[f];
  return out;
}

/**
 * Unisce i valori nuovi a un video (in memoria, senza scriverlo).
 *
 * @param video     il video salvato (non viene modificato)
 * @param incoming  { campo: valore nuovo } — solo i campi recuperati
 * @param options.fields campi da considerare (gli altri si ignorano)
 * @param options.rules  { campo: 'fill' | 'overwrite' | 'ask' }
 * @returns {{
 *   apply:     { campo: { from, to } },       da scrivere subito
 *   review:    { campo: { current, incoming } }, da decidere
 *   unchanged: string[],   uguali (o diversi con la regola "riempi solo i vuoti")
 *   locked:    string[],   bloccati: saltati
 *   protected: string[]    il nuovo era vuoto o un segnaposto: tenuto l'attuale
 * }}
 */
export function mergeVideoFields(video, incoming, { fields = FIELD_NAMES, rules = {}, currentThumbnail = undefined } = {}) {
  const r = normalizeRules(rules);
  const locks = new Set(video.locks ?? []);
  const out = { apply: {}, review: {}, unchanged: [], locked: [], protected: [] };
  for (const field of fields) {
    const def = META_FIELDS[field];
    if (!def || !(field in incoming)) continue;
    // La copertina attuale può arrivare già misurata (impronta visiva compresa).
    const current = field === 'thumbnail' && currentThumbnail !== undefined ? currentThumbnail : def.value(video);
    const next = incoming[field];
    const equal = def.equal ? def.equal(current, next) : sameJson(current, next);
    if (equal) { out.unchanged.push(field); continue; }
    if (locks.has(field)) { out.locked.push(field); continue; }
    if (isEmptyValue(next) || isPlaceholder(field, next)) {
      if (isEmptyValue(current)) out.unchanged.push(field);
      else out.protected.push(field);
      continue;
    }
    if (isEmptyValue(current) || isPlaceholder(field, current)) {
      out.apply[field] = { from: current, to: next };
      continue;
    }
    if (r[field] === 'overwrite') out.apply[field] = { from: current, to: next };
    else if (r[field] === 'ask') out.review[field] = { current, incoming: next };
    else out.unchanged.push(field);
  }
  return out;
}
