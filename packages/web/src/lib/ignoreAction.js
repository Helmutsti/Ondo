import { ignoreVideo } from '../api/client.js';
import { confirmDialog } from './dialog.js';
import { showToast } from './toast.js';

// «Ignora per sempre», sempre con conferma: il video viene cancellato dalla
// libreria con i suoi file e i controlli delle fonti non lo reinseriscono più.
// Ritorna true se è stato ignorato.
export async function ignoreWithConfirm(video) {
  const ok = await confirmDialog({
    title: 'Ignorare per sempre?',
    message: `"${video.title ?? video.id}" verrà cancellato dalla libreria: scheda, copertina e metadati${video.download === 'downloaded' ? ', e il file scaricato' : ''}. I controlli delle fonti non lo riprenderanno più, anche se resta nella playlist. Puoi sbloccarlo da Impostazioni › Nascosti e ignorati, ma andrà riscaricato, e non sempre si può.`,
    confirmLabel: 'Ignora per sempre',
    danger: true
  });
  if (!ok) return false;
  try {
    await ignoreVideo(video.id);
    showToast('Video ignorato: non tornerà con le sincronizzazioni.', 'success');
    return true;
  } catch (e) {
    showToast(e.message, 'error');
    return false;
  }
}
