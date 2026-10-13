import { readMetadata } from '../catalog/metadataStore.js';
import { readCatalog } from '../catalog/catalogStore.js';
import { markVideoRemoved } from './presenceService.js';
import { updateVideoMetadata } from './metadataUpdateService.js';
import { FIELD_NAMES } from './metadataFields.js';

// markVideoRemoved vive in presenceService (unico posto che cambia la presenza);
// resta esportato anche da qui per chi lo importava da questo modulo.
export { markVideoRemoved };

export async function getRawMetadata(id) {
  return readMetadata(id);
}

// "Aggiorna metadati" di un singolo video (CLI, e l'endpoint di sempre): ora
// passa dalla stessa unione del wizard (metadataUpdateService), con tutte le
// regole su "sovrascrivi" — ma i campi bloccati restano com'erano, un valore
// pieno non viene mai sostituito da un vuoto, e ogni cambio va in cronologia.
// Funziona anche sui RIMOSSI, come ri-verifica: se il video è di nuovo
// raggiungibile viene ripristinato. Un errore che non dice nulla del video
// torna al chiamante con la spiegazione per l'utente.
const OVERWRITE_ALL = Object.fromEntries(FIELD_NAMES.map((f) => [f, 'overwrite']));

export async function refreshVideoMetadata(id) {
  const r = await updateVideoMetadata(id, { fields: FIELD_NAMES, rules: OVERWRITE_ALL, label: 'Aggiorna metadati', origin: 'refresh' });
  const video = (await readCatalog()).videos[id];
  if (r.outcome === 'stop' || r.outcome === 'error') {
    const c = r.classification ?? {};
    const wrapped = new Error(`${c.hint ?? 'Aggiornamento non riuscito'}${c.message ? ` (${c.message})` : ''}`);
    wrapped.classification = r.classification;
    throw wrapped;
  }
  return video;
}
