import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
import { prepareSingleVideoDownload } from '../../services/singleVideoService.js';
import { fetchVideoMetadata } from '../../ytdlp/ytdlpWrapper.js';
import { classifyYtdlpError, errorRecord } from '../../ytdlp/errorClassifier.js';
import { applyRemoteVerdict } from '../../services/presenceService.js';

const ACTION_LABEL = {
  'already-downloaded': 'era già scaricato',
  'already-downloading': 'è già in download',
  'already-present': 'è già in libreria'
};

// Aggiunta "istantanea" di un singolo video dalla pagina Sorgenti: come
// addSourceJob, l'intera operazione gira come UN SOLO job in coda (risoluzione
// yt-dlp + stub + metadati completi + copertina). Non scarica MAI il video —
// per quello esiste già l'azione "Scarica video" sulla scheda, separata.
export async function addVideoJob({ url }, { log, progress }) {
  if (!url) throw new Error('addVideo richiede il parametro "url"');

  log('Risoluzione video…');
  const result = await prepareSingleVideoDownload(url, { download: false });
  progress(30);

  if (result.action !== 'added') {
    log(`"${result.title ?? result.videoId}" ${ACTION_LABEL[result.action] ?? result.action}.`);
    progress(100);
    return result;
  }

  log(`"${result.title ?? result.videoId}" aggiunto. Recupero metadati completi…`);
  try {
    const catalog = await readCatalog();
    const webpageUrl = catalog.videos[result.videoId]?.webpageUrl;
    const fields = await fetchVideoMetadata(result.videoId, webpageUrl, { onLog: log });
    const { video: _ignore, ...meta } = fields;
    await updateCatalog((cat) => {
      const current = cat.videos[result.videoId];
      if (!current) return; // rimosso nel frattempo
      Object.assign(current, meta, {
        enrichedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
    log(`✔ Metadati completi salvati.`);
  } catch (err) {
    // Il video resta comunque in libreria con i metadati leggeri già presenti:
    // un fallimento qui non deve far fallire l'intera aggiunta. La presenza
    // cambia solo se l'errore lo dice davvero (vedi presenceService).
    const classification = classifyYtdlpError(err);
    const outcome = await updateCatalog((cat) => {
      const current = cat.videos[result.videoId];
      if (!current) return null;
      current.enrichError = errorRecord(classification, { attempts: 1 });
      current.updatedAt = new Date().toISOString();
      return applyRemoteVerdict(current, classification, { isCheck: false }).outcome;
    });
    if (outcome === 'removed') log(`⊘ ${classification.hint}`);
    else log(`✘ Metadati completi non recuperati [${classification.category}]: ${classification.hint} — ${classification.message}`);
  }

  progress(100);
  return result;
}
