// Controlli automatici delle fonti (redesign R3), sul modello di
// backupScheduler: ogni minuto guarda le fonti con un controllo scaduto
// (source.nextCheckAt nel passato, secondo source.rules.checkEvery) e ne
// accoda UNA alla volta — al primo avvio dopo un aggiornamento sono tutte
// scadute, e quattordici controlli insieme sembrerebbero un attacco a YouTube.
// Non accoda una fonte che ha già un controllo in corso o in coda.
import { listSources } from './sourceService.js';
import { listActivity, triggerJob } from '../jobs/jobManager.js';

const TICK_MS = 60 * 1000;

export async function dueSources(now = Date.now()) {
  const sources = await listSources();
  const busy = new Set(
    listActivity().active
      .filter((j) => j.type === 'syncSource' || j.type === 'enrichSource')
      .map((j) => j.params?.sourceId ?? '*')
  );
  // Un arricchimento di TUTTE le fonti in corso (sourceId assente) occupa tutte.
  if (busy.has('*')) return [];
  return sources
    .filter((s) => s.rules.checkEvery && s.nextCheckAt && Date.parse(s.nextCheckAt) <= now && !busy.has(s.id))
    .sort((a, b) => a.nextCheckAt.localeCompare(b.nextCheckAt));
}

/** Avvia i controlli automatici. Ritorna una funzione per fermarli. */
export function startSourceScheduler({ log = console.log, logError = console.error } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const [next] = await dueSources();
      if (next) {
        triggerJob('syncSource', { sourceId: next.id, auto: true });
        log(`Controllo automatico accodato: "${next.name}".`);
      }
    } catch (err) {
      logError(`Controllo automatico delle fonti non riuscito: ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  // Primo giro poco dopo l'avvio, non subito: il server finisce di partire.
  const first = setTimeout(tick, 15 * 1000);
  first.unref();
  log('Controlli automatici delle fonti attivi (una fonte scaduta per minuto).');
  return () => { clearInterval(timer); clearTimeout(first); };
}
