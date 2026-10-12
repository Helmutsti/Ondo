// Risoluzione dei percorsi di una libreria ESTERNA (data/+media/ di un'altra
// installazione), usata dal merge (mergeService.js). A differenza di
// getPaths() (config.js) è sola lettura e parametrizzata su un root
// arbitrario: niente cache di processo, niente mkdirSync — la cartella
// sorgente non va mai toccata, solo letta.
import path from 'node:path';
import { isLibrary } from './library.js';

export function resolveForeignPaths(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const dataDir = path.join(root, 'data');
  // Stesso layout della libreria locale: catalogo in data/ (libreria.db, o i
  // vecchi libreria.json + metadata.json — readLibraryData li legge entrambi),
  // copertine e avatar in cima alla libreria.
  if (!isLibrary(root)) {
    throw new Error(`Cartella sorgente non valida: manca il catalogo in ${dataDir}`);
  }
  return {
    root,
    dataDir,
    thumbnailsDir: path.join(root, 'thumbnails'),
    avatarsDir: path.join(root, 'avatars')
  };
}
