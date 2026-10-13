import { useEffect, useState } from 'react';

// Modalità discreta: per usare Ondo in ufficio senza che copertine, foto
// profilo e (al livello 2) titoli e nomi si leggano da lontano. Preferenza
// solo client, come quelle del player (playerStore.js): vale per il browser
// in cui la si attiva, così può restare accesa al lavoro e spenta a casa.
//
// Livelli:
// - 'off'    → niente veli;
// - 'images' → copertine, foto profilo e immagine del player sfocate;
// - 'all'    → in più titoli, nomi di canali e fonti, descrizioni e tag, e il
//              titolo della scheda del browser resta "Ondo".
//
// Il velo è tutto CSS, guidato da attributi su <html>:
// - data-discreet="images|all" → il livello attivo;
// - data-discreet-peek         → Alt tenuto premuto: l'elemento sotto il
//                                mouse si vede finché non si lascia il tasto.
// Il player ha in più un "Mostra" per il solo video corrente (revealedId):
// in memoria, si azzera cambiando video o ricaricando la pagina.
const KEY = 'ondo:discreetMode';
export const DISCREET_LEVELS = ['off', 'images', 'all'];

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return DISCREET_LEVELS.includes(raw) ? raw : 'off';
  } catch {
    return 'off';
  }
}

// Stato appeso a globalThis per lo stesso motivo di playerStore.js (HMR).
const STATE = (globalThis.__ondoDiscreetState ??= {
  mode: load(),
  revealedId: null,
  listeners: new Set()
});

function applyToDocument() {
  const root = document.documentElement;
  if (STATE.mode === 'off') delete root.dataset.discreet;
  else root.dataset.discreet = STATE.mode;
}

function notify() {
  applyToDocument();
  for (const l of STATE.listeners) l();
}

export function getDiscreetMode() {
  return STATE.mode;
}

export function setDiscreetMode(mode) {
  if (!DISCREET_LEVELS.includes(mode)) return;
  STATE.mode = mode;
  STATE.revealedId = null;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // localStorage non disponibile (es. modalità privata): la preferenza resta
    // valida per la durata della scheda.
  }
  notify();
}

export function revealPlayer(id) {
  STATE.revealedId = id;
  notify();
}

export function useDiscreet() {
  const read = () => ({ mode: STATE.mode, revealedId: STATE.revealedId });
  const [snap, setSnap] = useState(read);
  useEffect(() => {
    const listener = () => setSnap(read());
    STATE.listeners.add(listener);
    listener();
    return () => STATE.listeners.delete(listener);
  }, []);
  return snap;
}

// Alt tenuto premuto = "sbircia". Il tasto si rilascia anche fuori dalla
// pagina (Alt+Tab): blur e visibilitychange tolgono comunque lo sbircio.
function installPeek() {
  if (globalThis.__ondoDiscreetPeek) return;
  globalThis.__ondoDiscreetPeek = true;
  const root = document.documentElement;
  const on = () => { root.dataset.discreetPeek = ''; };
  const off = () => { delete root.dataset.discreetPeek; };
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt') on(); });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') off(); });
  window.addEventListener('blur', off);
  document.addEventListener('visibilitychange', off);
}

// Applicato al caricamento del modulo (importato da main.jsx prima del primo
// render): la pagina non mostra mai, nemmeno per un istante, le immagini a
// modalità attiva.
applyToDocument();
installPeek();
