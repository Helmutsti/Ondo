import { statSync } from 'node:fs';
import { getPaths } from '../config.js';
import { DOWNLOAD_STATE, migrateVideoToFlags, migrateVideoToSources, normalizeVideoAxes } from './catalogSchema.js';
import { locateCurrentFile, buildVideoFileIndex } from '../services/libraryService.js';
import { getDb, onDbClosed, writeTransaction } from './db.js';
import { COLLECTIONS, KV_FIELDS, readCatalogFrom } from './sqlite.js';

// Il catalogo vive in data/libreria.db (vedi sqlite.js) ma i servizi lo usano
// come prima: un oggetto { videos, sources, channelAvatars, queue, meta } da
// leggere con readCatalog e da modificare dentro updateCatalog. Cambia solo
// cosa succede sotto quando si salva.
//
// Prima: a ogni modifica si rileggeva libreria.json da disco, si rifaceva la
// riconciliazione con la cartella dei video (un giro su TUTTI i file, anche su
// un NAS) e si riscriveva il file intero. Adesso: l'oggetto resta in memoria,
// una modifica scrive nel database solo le schede che sono cambiate, e la
// riconciliazione col disco si fa una volta, al primo caricamento del processo.
//
// Come si sa cosa è cambiato: per ogni scheda si tiene il JSON con cui è stata
// letta o scritta l'ultima volta (`saved`), e dopo il mutator si confronta.
// Serializzare tutto il catalogo costa qualche decina di millisecondi; scrivere
// solo le differenze ne risparmia decine di MB.
//
// Un altro processo (la CLI mentre gira il server) può aver scritto nel
// frattempo: lo dice `PRAGMA data_version`, che cambia solo per i commit delle
// ALTRE connessioni. Se è cambiato, si rilegge dal database prima di usare
// l'oggetto in memoria — al posto della rilettura a ogni modifica di prima.

let catalog = null;
let saved = null;       // Map "<campo>\0<chiave>" → JSON salvato
let savedKv = null;     // Map campo → JSON salvato (version, queue, meta)
let seenVersion = null; // data_version dell'ultima lettura
let writing = false;    // una transazione del catalogo è aperta in questo processo
let reconciled = false; // riconciliazione col disco già fatta in questo processo

onDbClosed(() => {
  catalog = null;
  saved = null;
  savedKv = null;
  seenVersion = null;
  reconciled = false;
});

function dataVersion(db) {
  return db.prepare('PRAGMA data_version').get().data_version;
}

function loadFromDb(db) {
  catalog = readCatalogFrom(db);
  saved = new Map();
  for (const { field } of COLLECTIONS) {
    for (const [k, value] of Object.entries(catalog[field])) saved.set(`${field}\0${k}`, JSON.stringify(value));
  }
  savedKv = new Map(KV_FIELDS.map((f) => [f, JSON.stringify(catalog[f])]));
  seenVersion = dataVersion(db);
}

// Scrive le sole differenze fra l'oggetto in memoria e quanto salvato. Va
// chiamata dentro una transazione. Ritorna quante righe ha toccato.
function persistChanges(db, cat) {
  let changes = 0;
  for (const { field, table, key } of COLLECTIONS) {
    const upsert = db.prepare(`INSERT OR REPLACE INTO ${table} (${key}, data) VALUES (?, ?)`);
    const remove = db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`);
    const prefix = `${field}\0`;
    const present = new Set();
    for (const [k, value] of Object.entries(cat[field] ?? {})) {
      const id = prefix + k;
      present.add(id);
      const json = JSON.stringify(value);
      if (saved.get(id) === json) continue;
      upsert.run(k, json);
      saved.set(id, json);
      changes++;
    }
    for (const id of [...saved.keys()]) {
      if (!id.startsWith(prefix) || present.has(id)) continue;
      remove.run(id.slice(prefix.length));
      saved.delete(id);
      changes++;
    }
  }
  if (changes > 0) cat.meta = { ...cat.meta, lastUpdated: new Date().toISOString() };
  const kv = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
  for (const field of KV_FIELDS) {
    const json = JSON.stringify(cat[field]);
    if (savedKv.get(field) === json) continue;
    kv.run(field, json);
    savedKv.set(field, json);
    changes++;
  }
  return changes;
}

// Azzera i campi del file fisico (usato quando il disco smentisce un
// `download: 'downloaded'` — stesso reset di deleteVideoFile, il file non c'è
// più quindi questi dati non hanno più senso).
function clearFileFields(video) {
  video.download = DOWNLOAD_STATE.NONE;
  video.video = {
    localPath: null, formatId: null, container: null, videoCodec: null, audioCodec: null,
    bitrateKbps: null, sizeBytes: null, sha256: null, downloadedAt: null, ytdlpVersion: null,
    qualityNote: null
  };
}

// Il disco fa fede su cosa è davvero scaricato, non il flag `download` letto
// dal JSON: un file può sparire (disco riformattato, cartella spostata a
// mano) senza passare da deleteVideoFile, e può esistere senza che il
// catalogo lo sappia ancora (istanza appena puntata su un archivio video
// preesistente, come in Docker con un mount diverso da quello con cui il
// catalogo era stato scritto). locateCurrentFile guarda per id (marcatore
// "[<id>]" nel nome, o vecchio layout piatto "<id>.<ext>"), quindi trova il
// file anche se il localPath registrato è sbagliato o assente.
function reconcileWithDisk(cat, paths) {
  let changed = false;
  const fileIndex = buildVideoFileIndex(paths.videosDir);
  for (const video of Object.values(cat.videos)) {
    const current = locateCurrentFile(paths, video, fileIndex);
    if (current) {
      if (video.download !== DOWNLOAD_STATE.DOWNLOADED || video.video?.localPath !== current.rel) {
        video.download = DOWNLOAD_STATE.DOWNLOADED;
        video.video = {
          ...video.video,
          localPath: current.rel,
          sizeBytes: video.video?.sizeBytes ?? statSync(current.abs).size
        };
        video.updatedAt = new Date().toISOString();
        changed = true;
      }
    } else if (video.download === DOWNLOAD_STATE.DOWNLOADED) {
      clearFileFields(video);
      video.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

function reconcileOnLoad(cat) {
  let changed = false;
  for (const video of Object.values(cat.videos)) {
    // Migrazione una tantum (M25) dal vecchio `status` singolo ai flag ortogonali.
    if (migrateVideoToFlags(video)) changed = true;
    // Migrazione una tantum (M41) dal vecchio `source` singolo a `sources` (array).
    if (migrateVideoToSources(video, cat.sources)) changed = true;
    // Normalizzazione una tantum (M87) dei campi aggiunti dopo: favorite/enrichedAt/missCount.
    if (normalizeVideoAxes(video)) changed = true;
    // Reconciliation: un download interrotto a metà (processo morto durante
    // il download) va riportato a "none" e rifatto da zero al prossimo trigger
    // — SE il disco (sotto) non trova comunque un file completo per questo id.
    if (video.download === DOWNLOAD_STATE.DOWNLOADING) {
      video.download = DOWNLOAD_STATE.NONE;
      video.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (reconcileWithDisk(cat, getPaths())) changed = true;
  // Migrazione: cataloghi scritti prima dell'introduzione delle foto profilo
  // dei canali (M14) non hanno ancora questo campo.
  if (!cat.channelAvatars) {
    cat.channelAvatars = {};
    changed = true;
  }
  // Migrazione: la coda dei link non ancora risolti (M85) non esiste nei
  // cataloghi precedenti. Un array vuoto è lo stato normale, non un caso
  // speciale da gestire altrove.
  if (!Array.isArray(cat.queue)) {
    cat.queue = [];
    changed = true;
  }
  return changed;
}

// Il catalogo in memoria, caricato (e riconciliato col disco) al primo uso e
// riletto se un altro processo ha scritto nel frattempo. Mai durante una
// modifica in corso: il mutator sta lavorando su questo stesso oggetto.
function ensureLoaded() {
  const db = getDb();
  if (!catalog) {
    loadFromDb(db);
  } else if (!writing && dataVersion(db) !== seenVersion) {
    loadFromDb(db);
  }
  return catalog;
}

// Migrazioni dei vecchi formati e riconciliazione col disco: una volta per
// processo, al primo accesso. È l'unico momento in cui si guarda l'intera
// cartella dei video.
async function ensureReconciled() {
  ensureLoaded();
  if (reconciled) return;
  reconciled = true;
  await updateCatalog((cat) => { reconcileOnLoad(cat); });
}

// ⚠️ Restituisce l'oggetto **vivo** in memoria, non una copia: va letto dentro
// un turno, non tenuto da parte attraverso degli `await`. Chi deve *decidere*
// sulla base di uno stato e poi scriverlo non può usare questa (vedi
// claimVideosForDownload): fra la lettura e la scrittura un altro job può aver
// cambiato tutto. Una copia profonda non risolverebbe niente — renderebbe la
// decisione stabilmente vecchia invece che casualmente vecchia — e costerebbe a
// ogni richiesta dell'API, quindi il rimedio giusto è mutare dentro il mutex.
export async function readCatalog() {
  await ensureReconciled();
  return ensureLoaded();
}

// Prende in carico dei video per il download, **in una sola mutazione atomica**.
//
// Esiste perché "controlla se è già in download, poi marcalo" fatto in due
// tempi è una decisione presa su dati che nel frattempo possono cambiare:
// finché la coda era single-worker non poteva succedere, con N download in
// parallelo due job prenderebbero in carico lo stesso id e lo scaricherebbero
// due volte. Qui il controllo e la marcatura stanno dentro `updateCatalog`,
// cioè dentro il mutex, quindi nessuno può infilarsi in mezzo.
//
// Ritorna **una fotografia** (id/titolo/url) dei soli video effettivamente
// presi in carico, catturata dentro il mutex: chi la usa dopo non rilegge lo
// stato vivo e quindi non ha niente di vecchio in mano.
//
// `allowRedownload` distingue i due chiamanti senza cambiare il comportamento
// di nessuno dei due: il download singolo può ri-scaricare un video già
// scaricato (è così che si riprova a una qualità più alta), il download in
// blocco no — salta sia i `downloaded` sia i `downloading`, come ha sempre
// fatto. In entrambi i casi un `downloading` non viene mai preso due volte.
export async function claimVideosForDownload(ids, { allowRedownload = false } = {}) {
  const claimed = [];
  await updateCatalog((cat) => {
    for (const id of ids) {
      const video = cat.videos[id];
      if (!video) continue;
      if (video.download === DOWNLOAD_STATE.DOWNLOADING) continue;
      if (!allowRedownload && video.download === DOWNLOAD_STATE.DOWNLOADED) continue;
      video.download = DOWNLOAD_STATE.DOWNLOADING;
      video.error = null;
      video.updatedAt = new Date().toISOString();
      claimed.push({ id, title: video.title ?? null, webpageUrl: video.webpageUrl ?? null });
    }
  });
  return claimed;
}

// Tutte le modifiche passano da qui, una per volta (la coda è in db.js), dentro
// una transazione SQLite: il mutator lavora sull'oggetto in memoria, poi si
// scrivono le sole schede cambiate. Se il mutator lancia, la transazione si
// annulla e l'oggetto in memoria — che può essere stato modificato a metà — si
// ricarica dal database; l'errore arriva al solo chiamante che l'ha causato.
export async function updateCatalog(mutator) {
  if (!reconciled && !writing) await ensureReconciled();
  try {
    return await writeTransaction(async (db) => {
      const nested = writing;
      if (!nested) {
        if (!catalog || dataVersion(db) !== seenVersion) loadFromDb(db);
        writing = true;
      }
      try {
        const result = await mutator(catalog);
        persistChanges(db, catalog);
        return result;
      } finally {
        if (!nested) writing = false;
      }
    });
  } catch (err) {
    if (!writing) {
      try { loadFromDb(getDb()); } catch { catalog = null; }
    }
    throw err;
  }
}
