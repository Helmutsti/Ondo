import { loadAppConfig, updateAppConfig } from '../appConfig.js';

// Blocco di YouTube (anti-bot, troppe richieste) con attesa crescente
// (redesign R3): quando YouTube frena, non si insiste. Il primo blocco mette
// in pausa per 15 minuti, ogni blocco successivo raddoppia l'attesa (fino a
// 6 ore); la prima richiesta che torna a funzionare azzera tutto.
//
// Vale per la macchina, non per la libreria (YouTube blocca l'indirizzo IP):
// sta nel file dell'applicazione, come il parallelismo.
const BASE_MS = 15 * 60 * 1000;
const MAX_MS = 6 * 60 * 60 * 1000;

function read() {
  return loadAppConfig()?.youtubeBlock ?? null;
}

/** Il blocco in corso ({ until, level, hint, since }) o null se si può lavorare. */
export function getBlock(now = Date.now()) {
  const b = read();
  if (!b?.until || Date.parse(b.until) <= now) return null;
  return b;
}

/** YouTube ha bloccato: la prossima attesa è il doppio della precedente. */
export function noteBlocked(classification, now = Date.now()) {
  const prev = read();
  const level = Math.min((prev?.level ?? 0) + 1, 10);
  const wait = Math.min(BASE_MS * 2 ** (level - 1), MAX_MS);
  const block = {
    level,
    since: prev?.since ?? new Date(now).toISOString(),
    until: new Date(now + wait).toISOString(),
    hint: classification?.hint ?? null,
    message: classification?.message ?? null
  };
  updateAppConfig({ youtubeBlock: block });
  return block;
}

/** Una richiesta è andata a buon fine: niente più blocco né attesa crescente. */
export function noteUnblocked() {
  if (read()) updateAppConfig({ youtubeBlock: null });
}
