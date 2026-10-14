import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { acquireDataLock } from './lock.js';
import { inPath, findVlc } from './lib/which.js';
import { INSTALL_ROOT, CORE_DIR } from './lib/installRoot.js';
import { deepMerge } from './lib/deepMerge.js';
import { loadAppConfig, appConfigDir } from './appConfig.js';
import { DATA_DIR_NAME, CATALOG_FILE_NAME, LIBRARY_CONFIG_FILE_NAME, libraryRoot, toolsRoot } from './library.js';

// M96 — il file di configurazione della LIBRERIA (data/conf.json). Conteneva
// una cosa sola, dove stavano i video (`videosRoot`); ora i video stanno sempre
// in <libreria>/videos e il file resta vuoto, pronto per ciò che è davvero
// della libreria. Tutto il resto (qualità, parallelismo, formato, porta, VLC) è
// passato nel file dell'APPLICAZIONE, vedi appConfig.js — che spiega anche la
// regola per decidere dove va un campo.
//
// I video stanno SEMPRE in <libreria>/videos: chi li vuole su un altro disco
// monta quella cartella (bind mount Docker, link simbolico, junction), e la
// libreria resta autoportante anche così. Prima c'era `videosRoot`, un percorso
// in questo file: un'impostazione in più che il binding fa già meglio.
const DEFAULT_CONFIG = {};

// Il file della libreria ATTIVA: dipende da quale libreria si sta usando
// (M98: la cartella corrente), quindi è una funzione e non una costante.
function configPath() {
  return path.join(libraryRoot(), DATA_DIR_NAME, LIBRARY_CONFIG_FILE_NAME);
}

let cachedConfig = null;

/**
 * Le impostazioni della LIBRERIA attiva.
 *
 * M98 — se il file non c'è si usano i default **in memoria**, senza scriverlo.
 * Prima lo creava, e con la libreria presa dalla cartella corrente quello
 * basterebbe a seminare `data/conf.json` in giro. Il file lo scrive
 * `initLibrary()`, oppure `updateLibraryConfig()` quando l'utente cambia
 * davvero qualcosa.
 */
export function loadLibraryConfig() {
  if (cachedConfig) return cachedConfig;

  const file = configPath();
  const userConfig = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};

  cachedConfig = deepMerge(DEFAULT_CONFIG, userConfig);
  warnLegacyVideosRoot(cachedConfig);
  return cachedConfig;
}

// Aggiorna il config della libreria: legge le override utente dal file, vi
// applica `patch` (deep-merge), riscrive atomicamente (tmp+rename) e INVALIDA la
// cache in-memory così il prossimo load rilegge da disco. Nota: per un
// processo già avviato (server) alcune cose sono fissate all'avvio (es. i mount
// express.static sui media), quindi resta comunque necessario un riavvio.
//
// M92 — lettura e scrittura dentro il lock (data/): già rileggeva da disco a
// ogni chiamata invece di fidarsi della cache, quindi qui il rischio non era
// la staleness ma la sovrapposizione fisica di due scritture (server e CLI che
// aggiornano le impostazioni nello stesso istante); il lock copre quello.
// Il file dell'applicazione non passa da qui e non usa il lock: è di un solo
// programma, mentre questo file è nella libreria, condivisa.
export function updateLibraryConfig(patch) {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireDataLock();
  try {
    let userConfig = {};
    if (existsSync(file)) {
      userConfig = JSON.parse(readFileSync(file, 'utf-8'));
    }
    const updated = deepMerge(userConfig, patch);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    renameSync(tmp, file);
  } finally {
    release();
  }
  cachedConfig = null;
  return loadLibraryConfig();
}

// Un conf.json di prima può avere ancora `videosRoot`: non si usa più, e lo si
// dice una volta sola invece di far fallire l'avvio (i video non spariscono:
// basta montare la loro cartella su <libreria>/videos).
let legacyWarned = false;
function warnLegacyVideosRoot(config) {
  if (legacyWarned || !config.videosRoot) return;
  legacyWarned = true;
  console.warn(
    `[ondo] "videosRoot" in ${configPath()} è ignorato: i video stanno sempre in ` +
    `${path.join(libraryRoot(), 'videos')}. Per tenerli su un altro disco monta lì la loro cartella ` +
    `(bind mount Docker o link simbolico), poi togli la riga dal file.`
  );
}

// Cookie per YouTube (video privati/non listati/con limite d'età) — file
// Netscape cookie-jar esportato dal browser. Vive accanto alle impostazioni
// dell'applicazione (`<config>/cookies.txt`, in Docker /config, già un
// volume): prima stava in `core/cookies.txt`, DENTRO l'immagine, e spariva a
// ogni aggiornamento del container. Il vecchio percorso si legge ancora, così
// un'installazione che lo usa non perde i cookie; il primo upload li scrive
// nel posto nuovo. getPaths() lo rileva a ogni chiamata: niente riavvio dopo
// un upload/cancellazione, il prossimo comando yt-dlp lo vede già.
const LEGACY_COOKIES_PATH = path.join(CORE_DIR, 'cookies.txt');

function cookiesFilePath() {
  return path.join(appConfigDir(), 'cookies.txt');
}

/** Il file dei cookie in uso, o null: quello nuovo, altrimenti il vecchio. */
function activeCookiesPath() {
  const current = cookiesFilePath();
  if (existsSync(current)) return current;
  return existsSync(LEGACY_COOKIES_PATH) ? LEGACY_COOKIES_PATH : null;
}

export function getCookiesStatus() {
  const active = activeCookiesPath();
  if (!active) return { present: false, updatedAt: null };
  return { present: true, updatedAt: statSync(active).mtime.toISOString() };
}

export function saveCookiesFile(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('File cookie vuoto o non valido.');
  }
  const dest = cookiesFilePath();
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, dest);
  // Il vecchio file non deve restare a fare da ripiego con cookie scaduti.
  if (existsSync(LEGACY_COOKIES_PATH)) unlinkSync(LEGACY_COOKIES_PATH);
  return getCookiesStatus();
}

export function deleteCookiesFile() {
  for (const f of [cookiesFilePath(), LEGACY_COOKIES_PATH]) {
    if (existsSync(f)) unlinkSync(f);
  }
  return getCookiesStatus();
}

// Nomi attesi dei binari in tools/, per sistema operativo. FONTE UNICA: la usano
// sia getPaths() (per risolverli) sia scripts/setup.mjs (per scaricarli col nome
// giusto) sia preflight.js (per il messaggio d'errore) — se la convenzione
// cambiasse in un solo posto, i tre pezzi divergerebbero silenziosamente.
// I nomi di yt-dlp sono quelli delle release ufficiali; su Linux ARM l'asset si
// chiama `yt-dlp_linux_aarch64` ma va SALVATO come `yt-dlp_linux` (qui sotto),
// perché è quello che il codice cerca a runtime, a prescindere dall'architettura.
export function expectedToolNames(platform = process.platform) {
  return {
    ytdlp:
      platform === 'win32' ? 'yt-dlp.exe' :
      platform === 'darwin' ? 'yt-dlp_macos' :
      'yt-dlp_linux',
    ffmpeg: platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    ffprobe: platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  };
}

export function getPaths() {
  loadLibraryConfig(); // solo per l'avviso su un `videosRoot` rimasto
  // M96 — data/ e i video seguono la LIBRERIA (che può stare altrove);
  // tools/ e i cookie seguono l'INSTALLAZIONE (dove sta il codice). Nel caso
  // normale le due radici coincidono.
  const LIBRARY_ROOT = libraryRoot();
  // M97 — il layout della libreria, quattro cartelle in cima e i file
  // funzionali dentro data/:
  //
  //   <libreria>/videos/          i file video (altrove? si monta questa cartella)
  //   <libreria>/thumbnails/      le copertine
  //   <libreria>/avatars/         le foto profilo dei canali
  //   <libreria>/data/            libreria.db (catalogo e metadati, SQLite),
  //                               conf.json, jobs.json, il lock, l'archivio
  //
  // Copertine e avatar stavano dentro data/media/: ora sono in cima, alla pari
  // dei video. `data/` resta per ciò che è funzionale — il catalogo e i file di
  // servizio — e non contiene più immagini.
  const dataDir = path.join(LIBRARY_ROOT, DATA_DIR_NAME);
  // video.localPath è relativo a questa cartella (videosDir).
  const videosDir = path.join(LIBRARY_ROOT, 'videos');
  const thumbnailsDir = path.join(LIBRARY_ROOT, 'thumbnails');
  const avatarsDir = path.join(LIBRARY_ROOT, 'avatars');
  const jobsDir = path.join(dataDir, 'jobs');

  // M98 — qui NON si crea più niente. Prima queste tre righe facevano
  // `mkdirSync` su videos/thumbnails/avatars: comodo quando la libreria era una
  // sola e in un posto noto, ma da quando è «quella in cui ti trovi» significa
  // fabbricare una libreria in qualunque cartella da cui si lanci un comando.
  // Creare è compito di `initLibrary()` (core/src/library.js), e solo suo.
  // Nota: data/jobs/ (vecchio layout "un file per job") NON viene più creata —
  // lo storico vive in data/jobs.json (jobManager). Il path jobsDir resta
  // esposto solo per la migrazione una tantum dal vecchio layout, se presente.

  return {
    // M96 — due radici distinte, prima erano la stessa cosa (`projectRoot`).
    libraryRoot: LIBRARY_ROOT,
    installRoot: INSTALL_ROOT,
    coreDir: CORE_DIR,
    videosDir,
    thumbnailsDir,
    avatarsDir,
    dataDir,
    // Il catalogo è data/libreria.db (SQLite): schede, fonti, avatar, coda E
    // metadati grezzi, che erano libreria.json + metadata.json. L'archivio di
    // yt-dlp (M97) sta in data/: è un file funzionale, non un'immagine.
    catalogPath: path.join(dataDir, CATALOG_FILE_NAME),
    jobsDir,
    downloadArchivePath: path.join(dataDir, '.ytdlp-archive.txt'),
    ...getToolPaths()
  };
}

/**
 * I percorsi che appartengono all'INSTALLAZIONE: binari esterni, cookie, VLC.
 *
 * Separati da getPaths() (M98) perché **non richiedono una libreria**, e per un
 * motivo concreto: `ondo setup` scarica i binari e deve funzionare da qualunque
 * cartella, anche prima che una libreria esista. Se passasse da getPaths(),
 * lanciare `ondo setup` fuori da una libreria fallirebbe — e sarebbe assurdo,
 * perché i binari non hanno niente a che vedere con l'archivio. Vale anche per
 * `checkTools()`, che dice se l'installazione è completa.
 */
export function getToolPaths() {
  // Cookie: percorso fisso, non configurabile (M95) — accanto alle impostazioni
  // dell'applicazione, con il vecchio core/cookies.txt come ripiego (vedi
  // activeCookiesPath). Un campo che ne indicasse un altro sarebbe una seconda
  // sorgente di verità.
  const cookiesPath = activeCookiesPath();

  // Binari esterni (M95): due soli posti, in ordine — la cartella tools/
  // dell'INSTALLAZIONE (dove scrive `setup`), poi il PATH di sistema (Homebrew,
  // apt, /opt/ondo/bin nell'immagine Docker). Il nome cercato dipende dal
  // sistema operativo: così la stessa libreria gira su Windows/Linux/macOS
  // senza portarsi dietro percorsi di nessuno dei tre.
  //
  // M96/M98 — tools/ segue l'installazione, non la libreria: i binari sono del
  // computer, dieci librerie condividono lo stesso yt-dlp, e una libreria su un
  // disco esterno non deve pretendere di avere i binari accanto ai video.
  const toolNames = expectedToolNames();
  const ytdlpDefaultName = toolNames.ytdlp;
  const toolsDir = toolsRoot();
  const ytdlpInTools = path.join(toolsDir, ytdlpDefaultName);
  const ytdlpBinaryPath = existsSync(ytdlpInTools)
    ? ytdlpInTools
    // Se non c'è da nessuna parte si restituisce comunque il percorso in tools/:
    // è il posto dove DOVREBBE stare, ed è quello che preflight mostra nel
    // messaggio d'errore — più utile di un null o di un nome nudo.
    : (inPath(ytdlpDefaultName) ?? inPath('yt-dlp') ?? ytdlpInTools);

  // ffmpeg (usato da yt-dlp per fondere video+audio e convertire le copertine in
  // jpg): se sta in tools/, si passa quella cartella a yt-dlp via
  // --ffmpeg-location — così l'app funziona senza ffmpeg installato nel sistema.
  // Se resta null, yt-dlp lo cerca nel PATH, dove sta negli altri casi.
  const ffmpegName = toolNames.ffmpeg;
  const ffmpegLocation = existsSync(path.join(toolsDir, ffmpegName)) ? toolsDir : null;

  return {
    toolsDir,
    ytdlpBinaryPath,
    cookiesPath,
    ffmpegLocation,
    // VLC: un percorso nel file dell'applicazione lo impone (M96, per chi lo
    // tiene in un posto non standard); altrimenti lo si cerca (M95). null =
    // non installato.
    vlcPath: loadAppConfig().vlcPath || findVlc()
  };
}
