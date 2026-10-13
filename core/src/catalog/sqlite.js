// Il catalogo su SQLite: `data/libreria.db` al posto di libreria.json + metadata.json.
//
// Perché: i due JSON si riscrivevano PER INTERO a ogni modifica — una scheda
// segnata come preferita costava decine di MB scritti (metadata.json da solo
// arriva a ~90 MB su una libreria vera), e tenerli in memoria costava centinaia
// di MB di heap. Qui ogni modifica scrive solo le righe che cambiano, e le
// scritture sono transazioni vere: un processo che muore a metà non lascia un
// catalogo rotto, e due processi (server e CLI) non si sovrascrivono più.
//
// Lo schema è volutamente "a documenti": una riga per video/fonte/avatar con il
// JSON dell'oggetto, la stessa forma che i servizi usano già in memoria. Non c'è
// una colonna per ogni campo perché il resto del programma lavora sull'oggetto
// intero; le colonne si potranno aggiungere (indici, ricerca full-text) dove
// serviranno, senza cambiare la forma dei dati.
//
// Modulo puro: lavora su percorsi espliciti e non sa quale sia la libreria
// corrente (quello è compito di config.js/library.js), così lo usano tutti —
// la libreria attiva, la creazione di una libreria nuova, il ripristino da
// backup e la lettura di una libreria esterna da fondere.
//
// ⚠️ SQLite va tenuto su un disco LOCALE: su NFS/SMB i lock non sono affidabili
// e il database si può corrompere. I video possono stare dove si vuole.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

export const DB_FILE_NAME = 'libreria.db';
export const LEGACY_CATALOG_FILE_NAME = 'libreria.json';
export const LEGACY_METADATA_FILE_NAME = 'metadata.json';

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS videos          (id  TEXT PRIMARY KEY, data  TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS sources         (id  TEXT PRIMARY KEY, data  TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS channel_avatars (key TEXT PRIMARY KEY, data  TEXT NOT NULL) STRICT;
  -- Profili creator: uno o più canali della stessa persona (vedi profileService).
  CREATE TABLE IF NOT EXISTS profiles        (id  TEXT PRIMARY KEY, data  TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS metadata        (id  TEXT PRIMARY KEY, data  TEXT NOT NULL) STRICT;
  -- Il resto del catalogo, che non è una collezione: version, queue (array
  -- ordinato dei link non ancora risolti), meta.
  CREATE TABLE IF NOT EXISTS kv              (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

// I nomi delle collezioni del catalogo e la tabella che le contiene.
export const COLLECTIONS = [
  { field: 'videos', table: 'videos', key: 'id' },
  { field: 'sources', table: 'sources', key: 'id' },
  { field: 'channelAvatars', table: 'channel_avatars', key: 'key' },
  { field: 'profiles', table: 'profiles', key: 'id' }
];
export const KV_FIELDS = ['version', 'queue', 'meta'];

// `node:sqlite` è integrato in Node (22.13+), quindi niente moduli nativi da
// compilare — conta per l'immagine Docker, che costruisce node_modules su amd64
// e li copia nelle immagini arm64/armv7. Su alcune versioni stampa ancora un
// ExperimentalWarning a ogni avvio: rumore nel menu della CLI e nei log del
// container, quindi lo si silenzia — solo quello — al primo caricamento.
const require = createRequire(import.meta.url);
let sqliteModule = null;
function sqlite() {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (/sqlite/i.test(message ?? '')) return;
    return original.call(process, warning, ...rest);
  };
  try {
    sqliteModule = require('node:sqlite');
  } catch (err) {
    throw new Error(`Serve Node.js 22.13 o più recente (SQLite integrato): ${err.message}`);
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

/** Apre un database esistente (o lo crea vuoto, se manca e non è in sola lettura). */
export function openDatabase(file, { readOnly = false } = {}) {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file, { readOnly });
  // Un altro processo che sta scrivendo (server mentre la CLI salva) blocca per
  // pochi millisecondi: si aspetta invece di fallire subito con SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 15000');
  if (!readOnly) {
    // WAL: chi legge non blocca chi scrive e viceversa. synchronous=NORMAL è il
    // compromesso raccomandato con WAL: nessuna corruzione possibile, al più si
    // perde l'ultima transazione in caso di blackout.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
    const { user_version: current } = db.prepare('PRAGMA user_version').get();
    if (current > SCHEMA_VERSION) {
      db.close();
      throw new Error(`${file} è stato creato da una versione più recente del programma (schema ${current}): aggiorna.`);
    }
    if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

/** Esegue `fn` in una transazione: commit se va a buon fine, rollback se lancia. */
export function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Il catalogo completo, nella stessa forma dell'oggetto che era libreria.json. */
export function readCatalogFrom(db) {
  const catalog = { version: 1, videos: {}, sources: {}, channelAvatars: {}, profiles: {}, queue: [], meta: {} };
  for (const { field, table, key } of COLLECTIONS) {
    for (const row of db.prepare(`SELECT ${key} AS k, data FROM ${table}`).all()) {
      catalog[field][row.k] = JSON.parse(row.data);
    }
  }
  for (const row of db.prepare('SELECT key, value FROM kv').all()) {
    if (KV_FIELDS.includes(row.key)) catalog[row.key] = JSON.parse(row.value);
  }
  return catalog;
}

/** Tutti i metadati grezzi, { id: info }. Solo per la fusione di librerie: altrove si legge per id. */
export function readAllMetadataFrom(db) {
  const out = {};
  for (const row of db.prepare('SELECT id, data FROM metadata').all()) out[row.id] = JSON.parse(row.data);
  return out;
}

// Scrive TUTTO un catalogo (e i metadati) in un database vuoto. Va chiamata
// dentro una transazione.
function writeEverything(db, catalog, metadata) {
  for (const { field, table, key } of COLLECTIONS) {
    const insert = db.prepare(`INSERT OR REPLACE INTO ${table} (${key}, data) VALUES (?, ?)`);
    for (const [k, value] of Object.entries(catalog[field] ?? {})) insert.run(k, JSON.stringify(value));
  }
  const kv = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
  kv.run('version', JSON.stringify(catalog.version ?? 1));
  kv.run('queue', JSON.stringify(Array.isArray(catalog.queue) ? catalog.queue : []));
  kv.run('meta', JSON.stringify(catalog.meta ?? { lastUpdated: new Date().toISOString() }));
  const insertMeta = db.prepare('INSERT OR REPLACE INTO metadata (id, data) VALUES (?, ?)');
  for (const [id, info] of Object.entries(metadata ?? {})) insertMeta.run(id, JSON.stringify(info));
}

// Crea `file` con questo contenuto. Il database si costruisce accanto, con un
// nome temporaneo, e prende il nome definitivo solo quando è completo e chiuso:
// un'interruzione a metà non lascia mai un libreria.db che sembra valido ma è
// vuoto o incompleto (e isLibrary() lo riconoscerebbe come libreria).
export function createDatabase(file, catalog, metadata = {}) {
  const tmp = `${file}.creazione`;
  removeDatabaseFiles(tmp);
  const db = openDatabase(tmp);
  try {
    // Senza WAL mentre lo si costruisce: alla chiusura tutto è nel file
    // principale, e il rename sposta un database completo, non mezzo.
    db.exec('PRAGMA journal_mode = DELETE');
    inTransaction(db, () => writeEverything(db, catalog, metadata));
  } finally {
    db.close();
  }
  renameSync(tmp, file);
}

/** Il file del database e i suoi file accessori del WAL. */
export function removeDatabaseFiles(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) rmSync(f, { force: true });
}

/** Copia consistente di un database aperto (anche mentre altri scrivono), in un file nuovo. */
export function snapshotDatabase(db, destFile) {
  removeDatabaseFiles(destFile);
  db.prepare('VACUUM INTO ?').run(destFile);
}

function readJsonIfExists(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : fallback;
}

// Libreria scritta da una versione precedente (libreria.json + metadata.json)
// e non ancora convertita? La si converte, una volta sola: database nuovo, e i
// due JSON rinominati con il suffisso `.migrato` — non cancellati, sono la
// strada per tornare indietro se qualcosa non torna.
export function migrateLegacyLibrary(dataDir, { log = () => {} } = {}) {
  const dbFile = path.join(dataDir, DB_FILE_NAME);
  const catalogFile = path.join(dataDir, LEGACY_CATALOG_FILE_NAME);
  if (existsSync(dbFile) || !existsSync(catalogFile)) return false;
  const metadataFile = path.join(dataDir, LEGACY_METADATA_FILE_NAME);

  log(`Converto il catalogo in SQLite (${dbFile})...`);
  const catalog = readJsonIfExists(catalogFile, null);
  const metadata = readJsonIfExists(metadataFile, {});
  createDatabase(dbFile, catalog, metadata);
  renameSync(catalogFile, `${catalogFile}.migrato`);
  if (existsSync(metadataFile)) renameSync(metadataFile, `${metadataFile}.migrato`);
  log(`Catalogo convertito: ${Object.keys(catalog.videos ?? {}).length} video, ${Object.keys(metadata).length} metadati. I vecchi JSON restano come *.migrato.`);
  return true;
}

// Legge una libreria qualunque — nel formato nuovo o in quello vecchio — senza
// modificarla. Per la fusione: la libreria sorgente non si tocca, nemmeno per
// convertirla.
export function readLibraryData(dataDir) {
  const dbFile = path.join(dataDir, DB_FILE_NAME);
  if (existsSync(dbFile)) {
    const db = openDatabase(dbFile, { readOnly: true });
    try {
      return { catalog: readCatalogFrom(db), metadata: readAllMetadataFrom(db) };
    } finally {
      db.close();
    }
  }
  return {
    catalog: readJsonIfExists(path.join(dataDir, LEGACY_CATALOG_FILE_NAME), null),
    metadata: readJsonIfExists(path.join(dataDir, LEGACY_METADATA_FILE_NAME), {})
  };
}
