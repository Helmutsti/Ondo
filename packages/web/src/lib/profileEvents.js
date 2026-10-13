// Un profilo creator è cambiato (fissato, rinominato, foto, canali uniti):
// la sidebar e il pannello mobile ricaricano l'elenco dei fissati senza
// aspettare un cambio di pagina.
const EVENT = 'ondo:profiles-changed';

export function notifyProfilesChanged() {
  window.dispatchEvent(new Event(EVENT));
}

export function onProfilesChanged(fn) {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
