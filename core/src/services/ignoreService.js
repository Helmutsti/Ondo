import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { removeVideoFromLibrary } from './libraryService.js';

// «Ignora per sempre» (redesign R1): il video esce dalla libreria e la sync
// non lo reinserisce più, anche se la playlist continua a elencarlo. È la
// scrematura definitiva: per i video che non vuoi nemmeno vedere passare.
// Si torna indietro da Impostazioni › Video ignorati.

/** Ignora un video: lo toglie dalla libreria (con i file, se deleteFiles) e lo mette nell'elenco. */
export async function ignoreVideo(id, { deleteFiles = true } = {}) {
  const video = (await readCatalog()).videos[id];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
  const record = { id, title: video.title ?? null, channelName: video.channel?.name ?? null, at: new Date().toISOString() };
  await updateCatalog((cat) => {
    cat.ignored = [record, ...(cat.ignored ?? []).filter((x) => x.id !== id)];
  });
  await removeVideoFromLibrary(id, { deleteFiles });
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
