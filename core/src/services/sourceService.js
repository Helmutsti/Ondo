import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { getPlaylistEntries } from '../ytdlp/ytdlpWrapper.js';
import { extractPlaylistId, ingestPlaylistEntries, playlistCoverage } from './syncService.js';
import { DOWNLOAD_STATE, PRESENCE } from '../catalog/catalogSchema.js';
import { triggerJob } from '../jobs/jobManager.js';
import { rulesOf, validateRules, nextCheckFrom, maxHeightFor, DEFAULT_RULES } from './sourceRules.js';

// I video ancora nella fonte (quelli usciti dalla playlist restano in
// libreria con la loro etichetta, ma non ne fanno più parte).
function inSource(video, sourceId) {
  return video.sources?.some((s) => s.sourceId === sourceId && !s.leftAt);
}

// Da scaricare = ancora su YouTube, mai scaricato. I nascosti sono video come
// gli altri: nascondere toglie solo dalla vista della Libreria.
function isToDownload(video) {
  return video.presence === PRESENCE.PRESENT && video.download === DOWNLOAD_STATE.NONE;
}

export async function listSources() {
  const catalog = await readCatalog();
  const stats = {};
  for (const video of Object.values(catalog.videos)) {
    for (const s of video.sources ?? []) {
      if (s.leftAt) continue;
      const st = (stats[s.sourceId] ??= { videoCount: 0, downloaded: 0, toDownload: 0 });
      st.videoCount += 1;
      if (video.download === DOWNLOAD_STATE.DOWNLOADED) st.downloaded += 1;
      else if (isToDownload(video)) st.toDownload += 1;
    }
  }

  return Object.values(catalog.sources)
    .map((source) => {
      const rules = rulesOf(source);
      return {
        ...source,
        rules,
        nextCheckAt: rules.checkEvery ? (source.nextCheckAt ?? nextCheckFrom(rules, source.lastCheckedAt)) : null,
        videoCount: 0,
        downloaded: 0,
        toDownload: 0,
        ...stats[source.id]
      };
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** Gli id da scaricare di una fonte (per "anche quelli già in attesa"). */
export async function pendingIdsOfSource(sourceId) {
  const catalog = await readCatalog();
  return Object.values(catalog.videos).filter((v) => inSource(v, sourceId) && isToDownload(v)).map((v) => v.id);
}

/**
 * Cambia le regole di una fonte. Con `includeExisting` (e scaricamento
 * automatico acceso) accoda anche i video della fonte già presenti e non
 * scaricati; altrimenti l'automatico vale solo per i video che arriveranno.
 * @returns {{ source, queued: number }}
 */
export async function setSourceRules(sourceId, input, { includeExisting = false } = {}) {
  const changes = validateRules(input);
  let rules;
  await updateCatalog((cat) => {
    const source = cat.sources[sourceId];
    if (!source) throw new Error(`Fonte non trovata: "${sourceId}"`);
    rules = { ...rulesOf(source), ...changes };
    source.rules = rules;
    source.nextCheckAt = nextCheckFrom(rules, source.lastCheckedAt);
  });
  let queued = 0;
  if (includeExisting && rules.autoDownload) {
    queued = queueDownloads(await pendingIdsOfSource(sourceId), rules);
  }
  const source = (await listSources()).find((x) => x.id === sourceId);
  return { source, queued };
}

/** Accoda un download per video con la qualità della fonte (nessuna domanda). */
export function queueDownloads(ids, rules) {
  const maxHeight = maxHeightFor(rules);
  for (const videoId of ids) triggerJob('downloadSingle', { videoId, maxHeight, auto: true });
  return ids.length;
}

/** Esito di un controllo: data, prossimo controllo, errore o riepilogo. */
export async function recordSourceCheck(sourceId, { error = null, result = null } = {}) {
  await updateCatalog((cat) => {
    const source = cat.sources[sourceId];
    if (!source) return;
    const nowIso = new Date().toISOString();
    source.lastAttemptAt = nowIso;
    // Anche dopo un errore il prossimo tentativo segue la frequenza della
    // fonte: niente tentativi a raffica su una playlist sparita.
    source.nextCheckAt = nextCheckFrom(rulesOf(source), nowIso);
    source.lastError = error;
    if (result) source.lastResult = { ...result, at: nowIso };
  });
}

export async function addSource(url) {
  const playlistId = extractPlaylistId(url);
  if (!playlistId) {
    throw new Error('Solo playlist sono supportate per ora: l\'URL deve contenere un parametro "list=" (es. https://www.youtube.com/playlist?list=...)');
  }
  const canonicalUrl = `https://www.youtube.com/playlist?list=${playlistId}`;

  const existing = await readCatalog();
  if (existing.sources[playlistId]) {
    return { alreadyExists: true, sourceId: playlistId, name: existing.sources[playlistId].name };
  }

  const { title, entries, declaredCount } = await getPlaylistEntries(canonicalUrl);
  const paths = getPaths();

  let result;
  await updateCatalog((catalog) => {
    if (catalog.sources[playlistId]) {
      result = { alreadyExists: true, sourceId: playlistId, name: catalog.sources[playlistId].name };
      return;
    }
    catalog.sources[playlistId] = {
      type: 'playlist',
      id: playlistId,
      name: title ?? `Playlist ${playlistId}`,
      url: canonicalUrl,
      lastCheckedAt: new Date().toISOString(),
      rules: { ...DEFAULT_RULES },
      // Primo elenco: è il riferimento con cui si giudicano i prossimi (un
      // elenco molto più corto è sospetto, vedi syncService.assessEnumeration).
      lastGoodCount: entries.length
    };
    const ingestResult = ingestPlaylistEntries(catalog, catalog.sources[playlistId], entries, paths);
    result = {
      alreadyExists: false,
      sourceId: playlistId,
      name: catalog.sources[playlistId].name,
      newCount: ingestResult.newCount,
      // backlog #4: copertura enumerazione (enumerati vs dichiarati da YouTube)
      ...playlistCoverage(declaredCount, entries.length)
    };
  });

  return result;
}

export async function removeSource(sourceId) {
  return updateCatalog((catalog) => {
    if (!catalog.sources[sourceId]) {
      throw new Error(`Fonte non trovata: "${sourceId}"`);
    }
    delete catalog.sources[sourceId];
  });
}
