import { useEffect, useState } from 'react';

// Il filtro «Nascosti» della Libreria e dei creator si può togliere dalle
// Impostazioni: senza, i video nascosti non compaiono da nessuna parte. Solo
// client (localStorage), come la modalità discreta: vale per questo browser.
// Default: visibile.
const KEY = 'ondo:showHiddenFilter';

function load() {
  try { return localStorage.getItem(KEY) !== 'false'; } catch { return true; }
}

// Stato appeso a globalThis per lo stesso motivo di playerStore.js (HMR).
const STATE = (globalThis.__ondoHiddenFilterState ??= { show: load(), listeners: new Set() });

export function setShowHiddenFilter(v) {
  STATE.show = !!v;
  try { localStorage.setItem(KEY, String(STATE.show)); } catch { /* modalità privata */ }
  for (const l of STATE.listeners) l();
}

export function useShowHiddenFilter() {
  const [show, setShow] = useState(STATE.show);
  useEffect(() => {
    const l = () => setShow(STATE.show);
    STATE.listeners.add(l);
    l();
    return () => STATE.listeners.delete(l);
  }, []);
  return show;
}
