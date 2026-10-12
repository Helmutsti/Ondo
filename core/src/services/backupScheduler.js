// Backup periodico della libreria in una cartella (ONDO_BACKUP_DIR).
//
// Serve quando la libreria sta su un disco che non è già protetto — tipicamente
// il disco di una VM, con i soli video sul NAS: lì il catalogo è veloce da
// scrivere ma, se la VM muore, va perso. Lo zip è lo stesso del backup manuale
// (createBackup: tutto tranne i video e i cookie), quindi si ripristina dalla
// web app come quello.
//
//   ONDO_BACKUP_DIR          dove scrivere gli zip (es. una cartella sul NAS);
//                            non impostata = nessun backup automatico
//   ONDO_BACKUP_EVERY_HOURS  ogni quante ore (default 24)
//   ONDO_BACKUP_KEEP         quanti zip tenere, i più vecchi si cancellano (default 14)
//
// Il ritmo si misura dall'ultimo zip presente nella cartella, non dall'avvio
// del processo: un container che si riavvia spesso non produce un backup a ogni
// riavvio, e uno rimasto spento a lungo lo fa subito.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBackup } from './backupService.js';

const PREFIX = 'ondo-backup-';
const CHECK_EVERY_MS = 60 * 60 * 1000;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function listBackups(dir) {
  if (!existsSync(dir)) return [];
  // Il nome contiene il timestamp ISO: l'ordine alfabetico è quello cronologico.
  return readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.zip')).sort();
}

async function runBackup(dir, keep, log) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, `${PREFIX}${stamp}.zip`);
  // Prima su un nome temporaneo: uno zip a metà (NAS che sparisce durante la
  // scrittura) non deve mai sembrare un backup valido, né spingere fuori dalla
  // rotazione uno buono.
  const tmp = `${file}.tmp`;
  await writeFile(tmp, createBackup());
  await rename(tmp, file);

  const backups = listBackups(dir);
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    try { unlinkSync(path.join(dir, old)); } catch { /* best-effort */ }
  }
  log(`Backup della libreria salvato: ${file}`);
}

/** Avvia il backup periodico se ONDO_BACKUP_DIR è impostata. Ritorna una funzione per fermarlo. */
export function startBackupScheduler({ log = console.log, logError = console.error } = {}) {
  const dir = process.env.ONDO_BACKUP_DIR?.trim();
  if (!dir) return () => {};
  const everyMs = positiveNumber(process.env.ONDO_BACKUP_EVERY_HOURS, 24) * 60 * 60 * 1000;
  const keep = Math.floor(positiveNumber(process.env.ONDO_BACKUP_KEEP, 14));

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const last = listBackups(dir).at(-1);
      const lastAt = last ? statSync(path.join(dir, last)).mtimeMs : 0;
      if (Date.now() - lastAt >= everyMs) await runBackup(dir, keep, log);
    } catch (err) {
      // Un backup fallito (NAS non montato, disco pieno) non deve fermare il
      // server: si segnala e si riprova al controllo successivo.
      logError(`Backup automatico fallito: ${err.message}`);
    } finally {
      running = false;
    }
  };

  log(`Backup automatico attivo: ${dir} ogni ${everyMs / 3_600_000} h, tengo gli ultimi ${keep}.`);
  tick();
  const timer = setInterval(tick, Math.min(CHECK_EVERY_MS, everyMs));
  timer.unref();
  return () => clearInterval(timer);
}
