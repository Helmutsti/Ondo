import { useEffect, useState } from 'react';
import { getActivity } from '../api/client.js';

// Un solo controllo periodico di /api/activity per tutta l'app: lo leggono
// l'indicatore in alto, il pannello, la pagina Attività, la pagina Fonti e le
// card (progresso dei download anche dopo un ricaricamento). Ogni 2 s se c'è
// qualcosa in corso, ogni 15 s altrimenti; refreshActivity() lo anticipa
// subito dopo un'azione (download avviato, sync lanciata).
// Stato su globalThis per lo stesso motivo degli altri store (HMR di Vite).
const STATE = (globalThis.__ondoActivityState ??= {
  data: null,
  listeners: new Set(),
  timer: null,
  inFlight: null
});

const FAST_MS = 2000;
const SLOW_MS = 15000;

function notify() {
  for (const l of STATE.listeners) l(STATE.data);
}

function schedule() {
  clearTimeout(STATE.timer);
  if (STATE.listeners.size === 0) return;
  const busy = (STATE.data?.active?.length ?? 0) > 0;
  STATE.timer = setTimeout(load, busy ? FAST_MS : SLOW_MS);
}

async function load() {
  if (STATE.inFlight) return STATE.inFlight;
  STATE.inFlight = (async () => {
    try {
      STATE.data = await getActivity();
      notify();
    } catch {
      // Server non raggiungibile per un momento: si riprova al prossimo giro.
    } finally {
      STATE.inFlight = null;
      schedule();
    }
    return STATE.data;
  })();
  return STATE.inFlight;
}

/** Ricarica subito (dopo un'azione) e ritorna i dati freschi. */
export function refreshActivity() {
  return load();
}

export function getActivitySnapshot() {
  return STATE.data;
}

export function useActivity() {
  const [data, setData] = useState(STATE.data);
  useEffect(() => {
    STATE.listeners.add(setData);
    if (!STATE.data) load(); else schedule();
    return () => {
      STATE.listeners.delete(setData);
      if (STATE.listeners.size === 0) clearTimeout(STATE.timer);
    };
  }, []);
  return data;
}

// Etichette e categorie dei job, condivise da pannello e pagina.
export const JOB_LABEL = {
  downloadSingle: 'Download',
  quickDownload: 'Download',
  downloadPending: 'Download di gruppo',
  syncSource: 'Controllo',
  enrichSource: 'Metadati',
  addSource: 'Aggiunta fonte',
  addVideo: 'Aggiunta video'
};

export const isDownloadJob = (j) => j.type === 'downloadSingle' || j.type === 'quickDownload' || j.type === 'downloadPending';

// Un blocco di YouTube (anti-bot, limite di richieste) nelle ultime ore:
// la causa comune di molti errori insieme, mostrata come un solo avviso.
export function recentBlock(data, hours = 6) {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  return (data?.finished ?? []).find((j) => j.status === 'failed' && j.error?.category === 'blocked' && (j.finishedAt ?? '') >= since) ?? null;
}

// Il job di download di UN video ({ jobId, status, progress, queuePosition }
// o null). La card si ridisegna solo quando cambia il SUO stato, non a ogni
// aggiornamento dell'Attività: con 500 card farebbe la differenza.
export function useVideoActivity(videoId) {
  const pick = (d) => d?.videos?.[videoId] ?? null;
  const [entry, setEntry] = useState(() => pick(STATE.data));
  useEffect(() => {
    let last = JSON.stringify(pick(STATE.data));
    const listener = (d) => {
      const next = pick(d);
      const json = JSON.stringify(next);
      if (json !== last) { last = json; setEntry(next); }
    };
    STATE.listeners.add(listener);
    if (!STATE.data) load(); else schedule();
    return () => {
      STATE.listeners.delete(listener);
      if (STATE.listeners.size === 0) clearTimeout(STATE.timer);
    };
  }, [videoId]);
  return entry;
}
