// Le viste della Libreria, definite UNA volta: le stesse regole contano le
// chip e filtrano la griglia, così un numero sulla chip è sempre quello dei
// video che compaiono cliccandola. (Prima "Tutti" sommava le categorie e i
// video in download finivano contati due volte.)
//
// Due informazioni indipendenti per video, come nel core: se ce l'hai
// (download) e se è ancora su YouTube (presence). "Nascosto" toglie un video
// da tutte le viste tranne la sua; "Spariti" li mostra comunque, perché è lì
// che si vede il valore dell'archivio.

export const isLost = (v) => v.presence === 'removed' && v.download !== 'downloaded';
export const isSaved = (v) => v.presence === 'removed' && v.download === 'downloaded';

export const LIBRARY_VIEWS = [
  { value: 'tutti', label: 'Tutti', fn: (v) => !v.hidden },
  // I video in download restano in "Da scaricare" finché non finiscono,
  // invece di sparire all'avvio e ricomparire altrove.
  { value: 'da-scaricare', label: 'Da scaricare', dot: 'available', fn: (v) => !v.hidden && v.presence === 'present' && (v.download === 'none' || v.download === 'downloading') },
  { value: 'scaricati', label: 'Scaricati', dot: 'downloaded', fn: (v) => !v.hidden && v.download === 'downloaded' },
  // Un video sparito da YouTube sta in «Spariti», anche se un tentativo di
  // download è fallito: non è un problema da risolvere, non c'è più niente.
  { value: 'problemi', label: 'Problemi', dot: 'failed', fn: (v) => !v.hidden && v.download === 'failed' && v.presence !== 'removed' },
  { value: 'spariti', label: 'Spariti da YouTube', dot: 'removed', fn: (v) => v.presence === 'removed' },
  { value: 'preferiti', label: 'Preferiti', star: true, fn: (v) => !v.hidden && !!v.favorite },
  { value: 'nascosti', label: 'Nascosti', dot: 'hidden', fn: (v) => !!v.hidden }
];

export function viewByValue(value) {
  return LIBRARY_VIEWS.find((x) => x.value === value) ?? LIBRARY_VIEWS[0];
}

export function countViews(videos) {
  const counts = {};
  for (const view of LIBRARY_VIEWS) counts[view.value] = 0;
  for (const v of videos) {
    for (const view of LIBRARY_VIEWS) if (view.fn(v)) counts[view.value] += 1;
  }
  return counts;
}

// Tutte le fonti da cui il video è uscito (playlist che non lo elencano più):
// il video resta in libreria, ma nessuna fonte lo porta più.
export function leftAllSources(v) {
  return Array.isArray(v.sources) && v.sources.length > 0 && v.sources.every((s) => s.leftAt);
}

// Stato mostrato sulla copertina (pillola). null = nessuna pillola: un video
// scaricato e ancora su YouTube è lo stato normale.
export function coverState(video, { progress, queuePosition } = {}) {
  if (video.download === 'downloading') {
    return { kind: 'downloading', label: 'In download' };
  }
  // In coda (download avviato, non ancora partito): lo dice l'Attività.
  if (queuePosition != null && video.download !== 'downloaded') {
    return { kind: 'downloading', label: `In coda (${queuePosition}°)` };
  }
  if (video.download === 'failed') return { kind: 'failed', label: 'Errore' };
  if (isSaved(video)) return { kind: 'saved', label: 'Sparito da YouTube · salvato' };
  if (isLost(video)) return { kind: 'lost', label: 'Non più disponibile' };
  if (video.access && video.download !== 'downloaded') return { kind: 'restricted', label: 'Accesso limitato' };
  if (video.download !== 'downloaded') return { kind: 'available', label: 'Da scaricare' };
  return null;
}
