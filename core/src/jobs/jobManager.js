import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths } from '../config.js';
import { loadAppConfig, updateAppConfig } from '../appConfig.js';
import { acquireDataLock } from '../lock.js';
import { classifyYtdlpError } from '../ytdlp/errorClassifier.js';
import { noteBlocked } from '../services/blockState.js';

const emitter = new EventEmitter();
const jobs = new Map();
const queue = [];
const handlers = new Map(); // type -> async (params, ctx) => summary
// Un AbortController per ogni job "running" (M51, interruzione manuale): non
// serializzabile, quindi vive solo qui in memoria, mai in jobs.json — un job
// interrotto dopo un riavvio del processo torna semplicemente a girare come se
// nessuno l'avesse mai interrotto (nessun controller da recuperare).
const controllers = new Map();
let loaded = false;

// ── Il pool (M76) ────────────────────────────────────────────────────────────
//
// Prima qui c'era un booleano `processing`: un job per volta. Adesso è un
// contatore, ed è tutto ciò che serve — **non ci sono thread**. Il lavoro
// pesante di un download (rete, decodifica, mux) sta dentro yt-dlp e ffmpeg,
// che sono processi separati schedulati dal sistema su tutti i core; il nostro
// codice fa spawn, legge stdout riga per riga e parsa la percentuale, cioè I/O.
// Un pool di thread che facesse questo passerebbe la vita bloccato su `read()`
// di una pipe: N `spawn` concorrenti danno lo stesso parallelismo reale, con
// l'event loop che smista le righe.
let inFlight = 0;
// Due code con tetti separati (redesign R3): i download (pesanti, rete e
// disco) e tutto il resto — controlli delle fonti, metadati, aggiunte — che
// sono richieste leggere ma tante. Così un recupero di metadati non aspetta
// che finiscano dieci download, e viceversa.
const DOWNLOAD_TYPES = new Set(['downloadSingle', 'downloadPending', 'quickDownload']);
const poolOf = (job) => (DOWNLOAD_TYPES.has(job.type) ? 'download' : 'metadata');
const inFlightBy = { download: 0, metadata: 0 };

// Il tetto si rilegge dalla config a ogni giro invece di essere memorizzato,
// così cambiarlo dalle impostazioni ha effetto **a caldo** senza un canale
// dedicato: la config è in cache, quindi costa niente. Alzarlo fa partire
// subito altri job; **abbassarlo non interrompe nulla** — quelli in corso
// finiscono, semplicemente non vengono rimpiazzati.
// M96 — sta nel file dell'applicazione: quanti download in parallelo regga
// questa macchina non è una proprietà dell'archivio.
export function getJobParallelism() {
  const configured = loadAppConfig()?.jobs?.parallel;
  const n = Number.parseInt(configured, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// I lavori "leggeri" in parallelo (controlli delle fonti, metadati): default 2.
// Lo stesso numero è quanti video il wizard dei metadati elabora insieme.
export function getMetadataParallelism() {
  const n = Number.parseInt(loadAppConfig()?.jobs?.metadataParallel, 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

export function setMetadataParallelism(quanti) {
  const n = Math.max(1, Math.min(8, Number.parseInt(quanti, 10) || 1));
  updateAppConfig({ jobs: { metadataParallel: n } });
  nudgeJobPool();
  return getMetadataParallelism();
}

/**
 * Cambia il tetto e fa subito ripartire la coda se è stato alzato.
 * M96 — un solo punto di scrittura: prima la stessa coppia
 * "scrivi la config + nudge" era duplicata nella CLI e nella route del server.
 */
export function setJobParallelism(quanti) {
  const n = Math.max(1, Number.parseInt(quanti, 10) || 1);
  updateAppConfig({ jobs: { parallel: n } });
  nudgeJobPool();
  return getJobParallelism();
}

/** Quanti job stanno girando adesso, e quanti aspettano un posto libero. */
export function getPoolStatus() {
  return {
    running: inFlight,
    queued: queue.length,
    parallel: getJobParallelism(),
    metadataParallel: getMetadataParallelism(),
    runningDownloads: inFlightBy.download,
    runningMetadata: inFlightBy.metadata
  };
}

// M86 — «guarda se adesso c'è posto». Il tetto si rilegge a ogni giro di
// `pump()`, ma `pump()` lo chiamano solo l'arrivo di un job e la fine di un
// altro: **alzare** il parallelismo dalle impostazioni non farebbe partire
// niente finché non succede una di quelle due cose, e con la coda piena e
// nessun job in corso non succederebbe mai. Da chiamare dopo aver cambiato
// `jobs.parallel`.
export function nudgeJobPool() {
  ensureLoaded();
  pump();
}

// interruptible (M51): solo downloadSingle/downloadPending lo dichiarano —
// gli altri tipi (metadati soltanto, pochi secondi) restano non interrompibili
// di proposito, vedi PIANO.md.
export function registerJobHandler(type, handler, { interruptible = false } = {}) {
  handlers.set(type, { handler, interruptible });
}

function storeFilePath() {
  return path.join(getPaths().dataDir, 'jobs.json');
}

// Carica lo storico in memoria una sola volta. Se data/jobs.json non esiste ma
// c'è ancora il vecchio layout "un file per job" (data/jobs/<id>.json), lo
// consolida in un colpo solo e rimuove i vecchi file: migrazione una tantum
// trasparente, senza perdere nessun job già registrato.
function ensureLoaded() {
  if (loaded) return;

  const file = storeFilePath();
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    for (const [id, job] of Object.entries(data.jobs ?? {})) jobs.set(id, job);
    loaded = true;
    // Riconciliazione all'avvio (come catalogStore fa con downloading→none): un
    // job rimasto `running`/`queued` quando il processo è morto è ORFANO — il suo
    // worker e il suo AbortController vivevano solo in memoria e non esistono più.
    // Senza questo, resterebbe "in corso" per sempre nella UI: non interrompibile
    // (nessun controller da recuperare) né cancellabile (deleteJob rifiuta i
    // running/queued). Lo si chiude come `failed`, coerente con l'esito di
    // un'interruzione qualunque.
    if (reconcileOrphanJobs()) persistStore();
    return;
  }

  const dir = getPaths().jobsDir;
  const migratedFiles = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      try {
        const job = JSON.parse(readFileSync(full, 'utf-8'));
        if (job && job.id) {
          jobs.set(job.id, job);
          migratedFiles.push(full);
        }
      } catch {
        // File corrotto: lo si salta, non deve bloccare la migrazione.
      }
    }
  }
  loaded = true;
  reconcileOrphanJobs();
  persistStore();
  for (const f of migratedFiles) {
    try { rmSync(f); } catch { /* best-effort: il consolidato è già scritto */ }
  }
}

// Chiude come `failed` ogni job rimasto `running`/`queued` da un processo
// precedente (orfano: worker e AbortController vivevano solo in memoria). Va
// chiamata subito dopo aver popolato la Map da disco, prima che il jobManager
// serva richieste. Ritorna true se ha modificato qualcosa (per decidere il persist).
function reconcileOrphanJobs() {
  let changed = false;
  const now = new Date().toISOString();
  const resume = [];
  for (const job of jobs.values()) {
    if (job.status === 'running' || job.status === 'queued') {
      job.status = 'failed';
      job.error = { message: 'Interrotto dal riavvio dell\'applicazione (job orfano).' };
      job.finishedAt = now;
      changed = true;
      // Un aggiornamento dei metadati riparte da dove era arrivato: ogni
      // video è indipendente, quelli già fatti sono salvati (checkpoint).
      if (job.type === 'updateMetadata') {
        const done = new Set(job.checkpoint?.doneIds ?? []);
        const left = (job.params?.videoIds ?? []).filter((id) => !done.has(id));
        if (left.length) {
          job.error = { message: `Interrotto dal riavvio: ripreso da solo con i ${left.length} video rimasti.` };
          resume.push({ ...job.params, videoIds: left, resumedFrom: job.id });
        }
      }
    }
  }
  // Dopo il caricamento (gli handler sono registrati all'import del core).
  if (resume.length) setImmediate(() => { for (const params of resume) triggerJob('updateMetadata', params); });
  return changed;
}

// Scrittura atomica dell'intero storico (tmp + rename, atomico su NTFS). Non
// serve il mutex asincrono di catalogStore, e **continua a non servire con N job
// in parallelo** (M76): ogni mutazione della Map è sincrona e `persistStore` è
// sincrona, quindi fra la modifica in memoria e la scrittura non c'è nessun
// `await` in cui un altro job possa infilarsi. Il pericolo del parallelismo in
// Node non è la race dentro un turno — non esiste — ma l'interleaving *fra* due
// `await`: qui non ce ne sono.
//
// M92 — il lock qui protegge solo la sovrapposizione fisica di due scritture
// (server e CLI che chiudono un job nello stesso istante), non la staleness:
// `jobs` resta una Map in memoria per tutta la vita del processo e non viene
// riletta da disco a ogni scrittura come catalogStore/metadataStore. Due
// processi di lunga vita (server + menu interattivo) che eseguono job insieme
// possono quindi ancora perdersi a vicenda le voci — limite noto, non risolto
// qui: risolverlo servirebbe un merge con lo stato su disco, non solo un lock.
function persistStore() {
  const file = storeFilePath();
  const tmp = `${file}.tmp`;
  const release = acquireDataLock();
  try {
    const data = { version: 1, jobs: Object.fromEntries(jobs) };
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, file);
  } finally {
    release();
  }
}

export function triggerJob(type, params = {}) {
  if (!handlers.has(type)) throw new Error(`Tipo di job sconosciuto: "${type}"`);
  ensureLoaded();

  const job = {
    id: randomUUID(),
    type,
    params,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    logLines: [],
    summary: null,
    // M86 — quello che si sa del job **mentre** gira, non alla fine (`summary`).
    // È l'equivalente di `Event::Resolved`/`Event::Phase` del sentinel Rust: chi
    // disegna una riga di avanzamento ha bisogno del titolo appena la
    // risoluzione l'ha reso noto, non a download finito. Forma libera, riempita
    // dall'handler con `ctx.note({...})`.
    note: null,
    // M93 — percentuale corrente (0-100) o null se il job non ne riporta una
    // (es. enrichSource fra un video e l'altro). Non persistito su ogni tick
    // (cambia troppo spesso, vedi `log` sopra) — vive solo in memoria, letta
    // dal polling di un client (es. lo userscript "scripter") che non può
    // iscriversi al flusso SSE.
    progress: null,
    error: null
  };
  jobs.set(job.id, job);
  persistStore();
  queue.push(job.id);
  emitter.emit(`job:${job.id}:status`, job.status);
  pump();
  return { jobId: job.id };
}

export function getJob(id) {
  ensureLoaded();
  return jobs.get(id) ?? null;
}

// Ordine più recenti prima. Un job appena messo in coda non ha ancora
// `startedAt` (parte solo quando il worker single-thread lo raggiunge): senza
// ripiego su `queuedAt` finirebbe in fondo alla lista invece che in cima,
// vanificando l'aggiunta "istantanea" (l'item deve comparire subito, non solo
// quando il worker lo prende in carico).
export function listJobs(limit = 50) {
  ensureLoaded();
  return [...jobs.values()]
    .sort((a, b) => (b.startedAt || b.queuedAt || '').localeCompare(a.startedAt || a.queuedAt || ''))
    .slice(0, limit);
}

/**
 * Il quadro per la pagina Attività: TUTTI i job in corso e in coda (niente
 * tetto: con 100 download in coda servono tutti), più i terminati dal
 * momento `since` in poi.
 */
export function listActivity({ since } = {}) {
  ensureLoaded();
  const all = [...jobs.values()];
  const active = all.filter((j) => j.status === 'running' || j.status === 'queued');
  const finished = all
    .filter((j) => (j.status === 'success' || j.status === 'failed') && (!since || (j.finishedAt ?? '') >= since))
    .sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''));
  // Posizione in coda (1 = il prossimo a partire), come la vede l'utente.
  const position = new Map(queue.map((id, i) => [id, i + 1]));
  return { active: active.map((j) => ({ ...j, queuePosition: position.get(j.id) ?? null })), finished };
}

// Cancella un job dallo storico: rimuove solo il record (il video, i file su
// disco e la voce di catalogo restano intatti). Un job `running`/`queued` non è
// cancellabile — non esiste un meccanismo di abort, quindi cancellarne il record
// lascerebbe il worker a girare "orfano".
export function deleteJob(id) {
  ensureLoaded();
  const job = jobs.get(id);
  if (!job) throw new Error(`Job non trovato: "${id}"`);
  if (job.status === 'running' || job.status === 'queued') {
    throw new Error('Non puoi cancellare un job in corso o in coda: attendi che finisca, oppure interrompilo prima.');
  }
  jobs.delete(id);
  persistStore();
  return { deleted: 1 };
}

// Interruzione manuale (M51): solo per i tipi che la dichiarano interrompibile
// (downloadSingle/downloadPending — vedi INTERRUPTIBLE_TYPES in jobs/jobs/).
// Un job "queued" non ha ancora nessun processo: basta toglierlo dalla coda.
// Un job "running" viene fermato inviando l'abort al suo AbortController — lo
// stesso `signal` passato all'handler, che lo inoltra fino a `runYtdlp()`
// (spawn con opzione `signal`, uccide davvero il processo yt-dlp in corso).
// In entrambi i casi il job chiude come "failed", stesso trattamento di un
// qualunque altro errore (nessun nuovo stato): l'handler stesso, ricevendo
// l'abort, lancia/propaga un errore che jobManager già gestisce così.
export function cancelJob(id) {
  ensureLoaded();
  const job = jobs.get(id);
  if (!job) throw new Error(`Job non trovato: "${id}"`);
  if (job.status === 'queued') {
    const idx = queue.indexOf(id);
    if (idx !== -1) queue.splice(idx, 1);
    job.status = 'failed';
    job.error = { message: 'Interrotto dall\'utente prima di partire.' };
    job.finishedAt = new Date().toISOString();
    persistStore();
    emitter.emit(`job:${job.id}:status`, job.status);
    return { cancelled: true };
  }
  if (job.status === 'running') {
    const controller = controllers.get(id);
    if (!controller) throw new Error('Questo tipo di job non supporta l\'interruzione.');
    controller.abort();
    return { cancelled: true };
  }
  throw new Error('Il job è già terminato, non c\'è nulla da interrompere.');
}

// Svuota lo storico: cancella tutti i job terminati (`success`/`failed`),
// lasciando intatti gli eventuali `running`/`queued`. Un solo persist a fine
// giro. Ritorna quanti ne ha rimossi.
export function clearJobs() {
  ensureLoaded();
  let deleted = 0;
  for (const job of [...jobs.values()]) {
    if (job.status === 'running' || job.status === 'queued') continue;
    jobs.delete(job.id);
    deleted += 1;
  }
  if (deleted) persistStore();
  return { deleted };
}

export function onJobLog(id, callback) {
  emitter.on(`job:${id}:log`, callback);
  return () => emitter.off(`job:${id}:log`, callback);
}

export function onJobStatus(id, callback) {
  emitter.on(`job:${id}:status`, callback);
  return () => emitter.off(`job:${id}:status`, callback);
}

export function onJobProgress(id, callback) {
  emitter.on(`job:${id}:progress`, callback);
  return () => emitter.off(`job:${id}:progress`, callback);
}

// M86 — le annotazioni di un job in corso (vedi il campo `note`). A differenza
// del progresso, che è solo un evento, la nota resta **anche sul record**: chi
// arriva su una schermata a job già avviato la rilegge da `getJob`/`listJobs`
// invece di aver perso l'unico evento che la portava.
export function onJobNote(id, callback) {
  emitter.on(`job:${id}:note`, callback);
  return () => emitter.off(`job:${id}:note`, callback);
}

// Avvia job finché c'è posto e c'è coda. È l'unico punto che decide di partire:
// la si richiama quando arriva un job nuovo e quando uno finisce.
function pump() {
  const caps = { download: getJobParallelism(), metadata: getMetadataParallelism() };
  // Si scorre la coda in ordine e si avvia ogni job la cui coda ha posto:
  // un download in attesa non blocca un controllo che può partire subito.
  for (let i = 0; i < queue.length;) {
    const id = queue[i];
    const job = jobs.get(id);
    const pool = job ? poolOf(job) : 'metadata';
    if (inFlightBy[pool] >= caps[pool]) { i += 1; continue; }
    queue.splice(i, 1);
    if (!job) continue;
    inFlight += 1;
    inFlightBy[pool] += 1;
    // `runJob` non rilancia mai (cattura tutto e chiude il job come `failed`),
    // ma il `catch` resta come rete: un'eccezione sfuggita qui lascerebbe
    // un posto occupato da nessuno.
    runJob(id)
      .catch(() => {})
      .finally(() => {
        inFlight -= 1;
        inFlightBy[pool] -= 1;
        pump();
      });
  }
}

async function runJob(nextId) {
  const job = jobs.get(nextId);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  persistStore();
  emitter.emit(`job:${job.id}:status`, job.status);

  let linesSinceFlush = 0;
  const log = (line) => {
    job.logLines.push(line);
    emitter.emit(`job:${job.id}:log`, line);
    linesSinceFlush += 1;
    if (linesSinceFlush >= 25) {
      persistStore();
      linesSinceFlush = 0;
    }
  };
  const progress = (pct) => {
    job.progress = pct;
    emitter.emit(`job:${job.id}:progress`, pct);
  };
  // La nota si accumula (merge), non si sostituisce: l'handler ne aggiunge un
  // pezzo per volta (prima la fase, poi id/titolo appena risolti).
  const note = (fields) => {
    job.note = { ...(job.note ?? {}), ...fields };
    emitter.emit(`job:${job.id}:note`, job.note);
  };

  // Avanzamento da conservare anche se il processo muore (vedi la ripresa in
  // reconcileOrphanJobs): si scrive subito su disco.
  const checkpoint = (data) => {
    job.checkpoint = { ...(job.checkpoint ?? {}), ...data };
    persistStore();
  };

  const entry = handlers.get(job.type);
  const controller = entry.interruptible ? new AbortController() : null;
  if (controller) controllers.set(job.id, controller);

  try {
    job.summary = await entry.handler(job.params, { log, progress, note, checkpoint, signal: controller?.signal });
    job.status = 'success';
  } catch (err) {
    job.status = 'failed';
    // Con la categoria (dal classificatore, o già decisa dall'handler): la UI
    // raggruppa i problemi per causa e non mostra mai un "Errore" senza motivo.
    const c = controller?.signal.aborted
      ? { category: 'cancelled', reason: 'cancelled', hint: 'Interrotto da te.' }
      : (err.classification ?? classifyYtdlpError(err));
    job.error = { message: err.message, category: c.category, reason: c.reason, hint: c.hint };
    // Un blocco di YouTube mette in pausa i controlli automatici, con attesa
    // crescente (blockState). Non se il job l'ha già registrato da sé.
    if (c.category === 'blocked' && !err.blockNoted) noteBlocked(c);
    log(`✘ Job fallito: ${err.message}`);
  } finally {
    // **Esattamente un evento terminale per job**, `success` o `failed`, mai due
    // mai zero: è la regola su cui si appoggia tutto ciò che ascolta (la CLI che
    // aspetta la fine, l'SSE, chi conta i job attivi). Il `finally` è ciò che la
    // garantisce anche quando l'handler muore in un modo che non ha previsto.
    if (controller) controllers.delete(job.id);
    job.finishedAt = new Date().toISOString();
    persistStore();
    emitter.emit(`job:${job.id}:status`, job.status);
    // Il posto lo libera `pump()` nel suo `finally`, non questo: liberarlo qui
    // e là vorrebbe dire scalare `inFlight` due volte.
  }
}
