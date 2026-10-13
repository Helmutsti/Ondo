import { ignoreVideo } from '../api/client.js';
import { confirmDialog } from './dialog.js';
import { showToast } from './toast.js';

// «Ignora per sempre», con conferma: il video esce dalla libreria (file
// compresi) e i controlli delle fonti non lo reinseriscono più. Ritorna true
// se è stato ignorato.
export async function ignoreWithConfirm(video) {
  const ok = await confirmDialog({
    title: 'Ignorare per sempre?',
    message: `"${video.title ?? video.id}" esce dalla libreria${video.download === 'downloaded' ? ', file compreso,' : ''} e i controlli delle fonti non lo reinseriranno più, anche se resta nella playlist. Puoi annullarlo da Impostazioni › Video ignorati.`,
    confirmLabel: 'Ignora per sempre',
    danger: true
  });
  if (!ok) return false;
  try {
    await ignoreVideo(video.id, true);
    showToast('Video ignorato: non tornerà con le sincronizzazioni.', 'success');
    return true;
  } catch (e) {
    showToast(e.message, 'error');
    return false;
  }
}
