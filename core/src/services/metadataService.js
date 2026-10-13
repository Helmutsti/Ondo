import { readMetadata } from '../catalog/metadataStore.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { fetchVideoMetadata } from '../ytdlp/ytdlpWrapper.js';
import { classifyYtdlpError, isDefinitivelyGone } from '../ytdlp/errorClassifier.js';
import { applyRemoteVerdict, markVideoRemoved } from './presenceService.js';

// markVideoRemoved vive in presenceService (unico posto che cambia la presenza);
// resta esportato anche da qui per chi lo importava da questo modulo.
export { markVideoRemoved };

export async function getRawMetadata(id) {
  return readMetadata(id);
}

// "Aggiorna metadati" (M31): ri-scarica i metadati completi + la copertina di un
// singolo video. Funziona anche sui RIMOSSI, come ri-verifica: se il video è di
// nuovo raggiungibile viene ripristinato. Un errore cambia la presenza solo se
// il classificatore lo considera definitivo (o conferma un "unavailable"); in
// tutti gli altri casi lo stato resta com'è e l'errore torna al chiamante con
// la spiegazione per l'utente.
export async function refreshVideoMetadata(id) {
  const catalog = await readCatalog();
  const video = catalog.videos[id];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);

  try {
    const fields = await fetchVideoMetadata(id, video.webpageUrl);
    const { video: _ignore, ...meta } = fields;
    return await updateCatalog((cat) => {
      const cur = cat.videos[id];
      if (!cur) return null;
      Object.assign(cur, meta, { enrichedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), enrichError: null });
      applyRemoteVerdict(cur, null, { isCheck: false });
      return cur;
    });
  } catch (err) {
    const classification = classifyYtdlpError(err);
    const updated = await updateCatalog((cat) => {
      const cur = cat.videos[id];
      if (!cur) return null;
      const { outcome } = applyRemoteVerdict(cur, classification, { isCheck: false });
      if (outcome !== 'stop') cur.updatedAt = new Date().toISOString();
      return cur;
    });
    // Un video confermato sparito non è un errore dell'operazione: torna la
    // scheda aggiornata. Tutto il resto viene segnalato con il suo motivo.
    if (isDefinitivelyGone(classification) || updated?.presence === 'removed') return updated;
    const wrapped = new Error(`${classification.hint} (${classification.message})`);
    wrapped.classification = classification;
    throw wrapped;
  }
}
