// Backup e ripristino dello stato del catalogo in un archivio .zip (M36, esteso
// in M61). Contiene TUTTO lo stato ricostruibile TRANNE i file video grezzi (i
// pesanti): il catalogo (libreria.db, con i metadati grezzi), lo storico dei
// job, le impostazioni della libreria (conf.json) e le immagini (copertine +
// avatar). Il ripristino accetta anche gli zip delle versioni precedenti, con
// libreria.json + metadata.json al posto del database. NON include i video (ri-scaricabili), né
// core/cookies.txt (dati di sessione sensibili, lo zip non è cifrato), né le
// impostazioni dell'APPLICAZIONE — quelle vivono con l'installazione (M96), non
// con la libreria, e un ripristino non deve riconfigurare il programma.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { acquireDataLock } from '../lock.js';
import { createZip, readZip } from '../lib/zip.js';
import { closeDb, getDb } from '../catalog/db.js';
import {
  DB_FILE_NAME, LEGACY_CATALOG_FILE_NAME, LEGACY_METADATA_FILE_NAME,
  createDatabase, openDatabase, readCatalogFrom, removeDatabaseFiles, snapshotDatabase
} from '../catalog/sqlite.js';

// Whitelist esplicita dei file dati JSON inclusi nel backup. Da M61 include
// anche il config della libreria (che da M96 contiene solo il percorso dei
// video: l'utente accetta che un ripristino su un'altra macchina lo
// sovrascriva). In
// ripristino non viene MAI scritto un nome di file diverso da questi, anche se
// presente nello zip (sicurezza: nessun path traversal / sovrascrittura
// arbitraria dallo zip). cookies.txt resta escluso (dati di sessione sensibili).
// Il catalogo (libreria.db) non è qui: si copia a parte, con VACUUM INTO. Il
// config della libreria è `conf.json` (oggi vuoto: i video stanno sempre in <libreria>/videos).
const BACKUP_JSON_FILES = ['jobs.json', 'conf.json'];
// Il catalogo delle versioni precedenti: si accetta solo in ripristino, e si
// converte nel database invece di essere scritto come file.
const LEGACY_JSON_FILES = [LEGACY_CATALOG_FILE_NAME, LEGACY_METADATA_FILE_NAME];

// Cartelle immagini incluse nel backup: prefisso nello zip → cartella su disco.
// Sono copertine (thumbnails) e avatar dei canali: immagini, non video, quindi
// dentro "tutto tranne i video grezzi". I nomi nello zip sono `<prefisso>/<file>`.
const IMAGE_DIRS = ['thumbnails', 'avatars'];

function dataFilePath(name) {
  return path.join(getPaths().dataDir, name);
}

// Mappa prefisso zip → cartella su disco, risolta al momento (getPaths crea le
// cartelle se mancano).
function imageDirPath(prefix) {
  const paths = getPaths();
  return prefix === 'thumbnails' ? paths.thumbnailsDir : paths.avatarsDir;
}

// Timestamp filesystem-safe (niente ':' per Windows): 2026-07-21T14-30-05.
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Elenca i soli file (non le sottocartelle) di una cartella, vuoto se assente.
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Crea un backup .zip in memoria: catalogo (libreria.db) + storico dei job +
 * impostazioni + immagini (copertine/avatar). Esclude i video grezzi e i cookie.
 * @returns {Buffer} i byte dell'archivio zip
 */
export function createBackup() {
  const entries = [];

  // Il database si copia con VACUUM INTO, non leggendo il file: con il WAL una
  // parte delle ultime scritture può stare ancora in libreria.db-wal, e un
  // altro processo può scrivere proprio adesso. La copia è consistente.
  const { dataDir } = getPaths();
  const snapshot = path.join(dataDir, `.backup-${process.pid}-${Date.now()}.db`);
  try {
    snapshotDatabase(getDb(), snapshot);
    entries.push({ name: DB_FILE_NAME, data: readFileSync(snapshot) });
  } finally {
    rmSync(snapshot, { force: true });
  }

  for (const name of BACKUP_JSON_FILES) {
    const p = dataFilePath(name);
    if (existsSync(p)) entries.push({ name, data: readFileSync(p) });
  }

  for (const prefix of IMAGE_DIRS) {
    const dir = imageDirPath(prefix);
    for (const file of listFiles(dir)) {
      entries.push({ name: `${prefix}/${file}`, data: readFileSync(path.join(dir, file)) });
    }
  }

  if (entries.length === 0) throw new Error('Nessun file da salvare nel backup.');
  return createZip(entries);
}

// Riconosce un'entry immagine valida (`thumbnails/<basename>` o
// `avatars/<basename>`, un solo livello, nessun path traversal). Ritorna
// { prefix, base } se valida, altrimenti null.
function parseImageEntryName(name) {
  const m = /^(thumbnails|avatars)\/([^/\\]+)$/.exec(name);
  if (!m) return null;
  const base = m[2];
  if (base === '.' || base === '..' || base.includes('/') || base.includes('\\')) return null;
  return { prefix: m[1], base };
}

/**
 * Ripristina da un backup .zip (nuovo, con libreria.db, o di una versione
 * precedente, con libreria.json + metadata.json). Prima copia catalogo e file
 * dati attuali in una cartella di sicurezza `data/pre-restore-<timestamp>/`,
 * poi sostituisce il catalogo e i file JSON in whitelist presenti nello zip e
 * riscrive le immagini (copertine/avatar) nelle rispettive cartelle. Le
 * immagini vengono sovrascritte/aggiunte, mai cancellate: per questo non
 * entrano nella copia di sicurezza. Il catalogo si ricarica da sé; per
 * conf.json e lo storico dei job il processo (server/CLI) va riavviato.
 * @param {Buffer} zipBuffer
 * @returns {{restored: string[], restoredImages: number, backedUp: string[], safetyDir: string, requiresRestart: boolean}}
 */
export function restoreBackup(zipBuffer) {
  const entries = readZip(zipBuffer);
  const jsonByName = new Map();
  const imageEntries = [];
  let dbData = null;
  for (const e of entries) {
    if (e.name === DB_FILE_NAME) {
      dbData = e.data;
    } else if (BACKUP_JSON_FILES.includes(e.name) || LEGACY_JSON_FILES.includes(e.name)) {
      jsonByName.set(e.name, e.data);
    } else {
      const img = parseImageEntryName(e.name);
      if (img) imageEntries.push({ ...img, data: e.data });
      // Qualunque altro nome (fuori whitelist / prefisso sconosciuto / path
      // traversal) viene ignorato: nessuna scrittura arbitraria dallo zip.
    }
  }

  // Validazione: il catalogo è obbligatorio (database, o JSON di una versione
  // precedente); ogni file JSON riconosciuto dev'essere JSON valido (evita di
  // sostituire i dati con spazzatura).
  if (!dbData && !jsonByName.has(LEGACY_CATALOG_FILE_NAME)) {
    throw new Error(`Backup non valido: manca il catalogo (${DB_FILE_NAME} o ${LEGACY_CATALOG_FILE_NAME}).`);
  }
  const parsed = new Map();
  for (const [name, data] of jsonByName) {
    try {
      parsed.set(name, JSON.parse(data.toString('utf-8')));
    } catch {
      throw new Error(`Backup non valido: ${name} non è JSON valido.`);
    }
  }

  const { dataDir, catalogPath } = getPaths();

  // Il nuovo database si prepara accanto a quello attuale e lo si controlla
  // PRIMA di toccare qualunque cosa: uno zip con un database illeggibile non
  // deve lasciare la libreria senza catalogo.
  const incoming = `${catalogPath}.ripristino`;
  removeDatabaseFiles(incoming);
  try {
    if (dbData) {
      writeFileSync(incoming, dbData);
      const check = openDatabase(incoming, { readOnly: true });
      try {
        readCatalogFrom(check);
      } finally {
        check.close();
      }
    } else {
      createDatabase(incoming, parsed.get(LEGACY_CATALOG_FILE_NAME), parsed.get(LEGACY_METADATA_FILE_NAME) ?? {});
    }
  } catch (err) {
    removeDatabaseFiles(incoming);
    throw new Error(`Backup non valido: il catalogo non si legge (${err.message}).`);
  }

  // M92 — un lock solo, tenuto per tutto il ripristino: è una sostituzione
  // fisica di file su disco, quindi tutta l'operazione va trattata come una
  // singola scrittura.
  const release = acquireDataLock();
  let safetyDir, backedUp, restored, restoredImages;
  try {
    // 1. Copia di sicurezza del catalogo e dei file dati attuali.
    safetyDir = path.join(dataDir, `pre-restore-${timestamp()}`);
    mkdirSync(safetyDir, { recursive: true });
    backedUp = [];
    if (existsSync(catalogPath)) {
      snapshotDatabase(getDb(), path.join(safetyDir, DB_FILE_NAME));
      backedUp.push(DB_FILE_NAME);
    }
    for (const name of BACKUP_JSON_FILES) {
      const current = dataFilePath(name);
      if (existsSync(current)) {
        copyFileSync(current, path.join(safetyDir, name));
        backedUp.push(name);
      }
    }

    // 2. Il catalogo: si chiude la connessione (le cache in memoria si
    // svuotano e al prossimo accesso si rilegge il database nuovo), si toglie
    // il vecchio con il suo WAL e si mette al suo posto quello preparato.
    restored = [];
    closeDb();
    removeDatabaseFiles(catalogPath);
    renameSync(incoming, catalogPath);
    restored.push(DB_FILE_NAME);

    // 3. Sostituzione atomica (tmp + rename) degli altri file dati in whitelist.
    for (const name of BACKUP_JSON_FILES) {
      if (!jsonByName.has(name)) continue;
      const dest = dataFilePath(name);
      const tmp = `${dest}.restore-tmp`;
      writeFileSync(tmp, jsonByName.get(name));
      renameSync(tmp, dest);
      restored.push(name);
    }

    // 4. Immagini (copertine/avatar): scrittura atomica nel basename validato.
    restoredImages = 0;
    for (const img of imageEntries) {
      // M98 — risolvere un percorso non tocca il disco: la cartella si assicura qui.
      const dir = imageDirPath(img.prefix);
      mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, img.base);
      const tmp = `${dest}.restore-tmp`;
      writeFileSync(tmp, img.data);
      renameSync(tmp, dest);
      restoredImages++;
    }
  } finally {
    removeDatabaseFiles(incoming);
    release();
  }

  // Il catalogo si ricarica da sé (vedi closeDb); il riavvio serve ancora per
  // conf.json e lo storico dei job, che i processi leggono all'avvio.
  return { restored, restoredImages, backedUp, safetyDir, requiresRestart: true };
}
