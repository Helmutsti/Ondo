import { readCatalog, updateCatalog, claimVideosForDownload } from '../../catalog/catalogStore.js';
import { DOWNLOAD_STATE } from '../../catalog/catalogSchema.js';
import { downloadVideo } from '../../ytdlp/ytdlpWrapper.js';
import { recordDownloadFailure } from '../../services/presenceService.js';

export async function downloadSingleJob(params, { log, progress, signal }) {
  const { videoId, audioStrategy, maxHeight } = params;
  if (!videoId) throw new Error('downloadSingle richiede il parametro "videoId"');

  const catalog = await readCatalog();
  if (!catalog.videos[videoId]) throw new Error(`Video non trovato nel catalogo: ${videoId}`);

  // Presa in carico atomica: se un altro job sta già scaricando questo video,
  // `claimed` è vuoto e ci si ferma qui invece di scaricarlo due volte in
  // parallelo sullo stesso file di destinazione.
  const [video] = await claimVideosForDownload([videoId], { allowRedownload: true });
  if (!video) throw new Error(`Il video ${videoId} è già in download: attendi che finisca, oppure interrompilo.`);

  log(`--- ${videoId}: ${video.title ?? '(titolo sconosciuto)'} ---`);

  try {
    const fields = await downloadVideo(videoId, video.webpageUrl, { onLog: log, onProgress: progress, signal, audioStrategy, maxHeight });
    await updateCatalog((cat) => {
      Object.assign(cat.videos[videoId], fields, {
        download: DOWNLOAD_STATE.DOWNLOADED,
        updatedAt: new Date().toISOString(),
        error: null
      });
    });
    log(`✔ ${videoId} scaricato con successo.`);

    return { downloaded: 1, failed: 0 };
  } catch (err) {
    // Interrotto da chi l'ha avviato: non è un fallimento. Il video torna
    // "da scaricare" com'era, senza errore (prima finiva tra i Problemi come
    // "errore non classificato").
    if (signal?.aborted) {
      await updateCatalog((cat) => {
        const v = cat.videos[videoId];
        if (!v) return;
        if (v.download === DOWNLOAD_STATE.DOWNLOADING) v.download = DOWNLOAD_STATE.NONE;
        v.updatedAt = new Date().toISOString();
      });
      log(`■ ${videoId}: download interrotto, il video torna da scaricare.`);
      throw err;
    }
    const { classification, outcome } = await recordDownloadFailure(videoId, err);
    if (outcome === 'removed') log(`⊘ ${videoId}: ${classification.hint}`);
    log(`✘ ${videoId} fallito [${classification.category}]: ${classification.hint} — ${classification.message}`);
    throw err;
  }
}
