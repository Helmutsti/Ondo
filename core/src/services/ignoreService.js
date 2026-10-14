import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { removeVideoFromLibrary } from './libraryService.js';

// «Ignora per sempre» (redesign R1): il video esce dalla libreria per sempre
// (scheda, file, copertina, metadati) e la sync non lo reinserisce più, anche
// se la playlist continua a elencarlo. Dell'elenco degli ignorati restano solo
// id, titolo, canale e data: quanto basta per riconoscerlo e non riprenderlo.
// Si torna indietro da Impostazioni › Video ignorati: il video rientra al
// prossimo controllo della fonte, da riscaricare (se c'è ancora).

/** Ignora un video: lo cancella dalla libreria con tutti i suoi file e lo mette nell'elenco. */
export async function ignoreVideo(id) {
  const video = (await readCatalog()).videos[id];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
  const record = { id, title: video.title ?? null, channelName: video.channel?.name ?? null, at: new Date().toISOString() };
  await updateCatalog((cat) => {
    cat.ignored = [record, ...(cat.ignored ?? []).filter((x) => x.id !== id)];
  });
  await removeVideoFromLibrary(id, { deleteFiles: true });
  return record;
}

export async function listIgnored() {
  return (await readCatalog()).ignored ?? [];
}

/** Toglie un video dall'elenco: al prossimo controllo della fonte, se c'è ancora, rientra. */
export async function unignoreVideo(id) {
  await updateCatalog((cat) => {
    cat.ignored = (cat.ignored ?? []).filter((x) => x.id !== id);
  });
  return listIgnored();
}
