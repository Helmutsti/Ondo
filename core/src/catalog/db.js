// La connessione al database della libreria CORRENTE, e l'unico punto da cui
// passano le scritture (catalogStore, metadataStore).
//
// Una connessione per processo: catalogo e metadati condividono la stessa, così
// una modifica che tocca entrambi (cancellare un video ne toglie anche i
// metadati grezzi) è UNA transazione — o tutto o niente.

import { AsyncLocalStorage } from 'node:async_hooks';
import { getPaths } from '../config.js';
import { openDatabase, migrateLegacyLibrary } from './sqlite.js';

let current = null; // { file, db }
const closeListeners = new Set();

/** Il database della libreria corrente, aperto (e convertito dai vecchi JSON) al primo uso. */
export function getDb() {
  const { dataDir, catalogPath } = getPaths();
  if (current?.file === catalogPath) return current.db;
  closeDb();
  migrateLegacyLibrary(dataDir, { log: (m) => console.log(m) });
  current = { file: catalogPath, db: openDatabase(catalogPath) };
  return current.db;
}

/**
 * Chiude la connessione (ripristino da backup, cambio di libreria). Chi tiene
 * cache costruite sul database viene avvisato e le butta: al prossimo accesso
 * si riapre e si rilegge tutto.
 */
export function closeDb() {
  if (!current) return;
  const { db } = current;
  current = null;
  for (const fn of closeListeners) fn();
  try { db.close(); } catch { /* già chiusa */ }
}

export function onDbClosed(fn) {
  closeListeners.add(fn);
}

// ── Scritture ────────────────────────────────────────────────────────────────
//
// Tutte in coda, una transazione per volta, perché la connessione è una sola e
// una transazione può restare aperta attraverso degli `await` (una modifica del
// catalogo che cancella file prima di togliere la scheda). Senza la coda, la
// scrittura di un altro job che capita in quel momento finirebbe DENTRO la
// transazione altrui — e sparirebbe con il suo rollback.
//
// Chi scrive mentre è già dentro una transazione (una modifica del catalogo che
// cancella anche i metadati) non si rimette in coda — aspetterebbe sé stesso
// per sempre — ma partecipa a quella in corso. "Dentro" lo dice
// AsyncLocalStorage, che segue la catena degli await della transazione e non
// quella di un job qualunque che gira nello stesso momento.
const inTransaction = new AsyncLocalStorage();
let queue = Promise.resolve();

/**
 * Esegue `fn(db)` in una transazione di scrittura. Commit se va a buon fine,
 * rollback se lancia (e l'errore arriva al chiamante, non agli altri in coda).
 */
export function writeTransaction(fn) {
  if (inTransaction.getStore()) return Promise.resolve().then(() => fn(getDb()));
  const run = queue.then(() => inTransaction.run(true, async () => {
    const db = getDb();
    // IMMEDIATE: il lock di scrittura si prende subito, non alla prima
    // scrittura — un altro processo che scrive nel frattempo fa aspettare qui
    // (busy_timeout), non fallire a metà transazione.
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* transazione già chiusa */ }
      throw err;
    }
  }));
  queue = run.catch(() => {});
  return run;
}
