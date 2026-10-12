// Area di lavoro locale per i download (ONDO_SCRATCH_DIR).
//
// Senza, yt-dlp e ffmpeg lavorano direttamente nella libreria: i .part scritti
// a pezzetti, i flussi video e audio separati, la fusione, l'hash e la lettura
// della risoluzione — ogni byte del video attraversa la rete 3-4 volte quando la
// libreria sta su un NAS (NFS/SMB). Con l'area di lavoro tutto questo avviene
// su un disco locale e la libreria riceve UNA scrittura sequenziale a fine
// download: il file finito, già verificato.
//
// Ogni download ha la sua sottocartella (<scratch>/<videoId>), che si cancella
// quando il download va a buon fine. Se fallisce resta, con il .part dentro:
// il tentativo successivo riprende da lì invece che da zero. Il contenuto è
// comunque usa-e-getta: all'avvio del server l'area viene svuotata
// (clearScratch), perché i job che la stavano usando non esistono più.
//
// Variabile non impostata = comportamento storico, si scarica nella libreria.
// È il caso della CLI, dove la libreria di solito è già su un disco locale e
// l'area di lavoro sarebbe solo una copia in più.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { copyFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export function scratchRoot() {
  const dir = process.env.ONDO_SCRATCH_DIR?.trim();
  return dir ? path.resolve(dir) : null;
}

/** La cartella di lavoro di un download, creata se manca. null se l'area di lavoro non è attiva. */
export function stagingDirFor(videoId) {
  const root = scratchRoot();
  if (!root) return null;
  const dir = path.join(root, videoId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeStagingDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Svuota l'area di lavoro (il contenuto, non la cartella: può essere il punto di mount di un volume). */
export function clearScratch() {
  const root = scratchRoot();
  if (!root || !existsSync(root)) return 0;
  const entries = readdirSync(root);
  for (const name of entries) removeStagingDir(path.join(root, name));
  return entries.length;
}

// Sposta un file anche fra filesystem diversi (area di lavoro locale → NAS),
// dove rename fallisce con EXDEV. La copia va prima su un nome temporaneo
// accanto alla destinazione e solo dopo prende il nome definitivo: chi guarda
// la libreria non vede mai un video a metà con il nome di uno finito.
// Asincrona: la copia di un video di qualche GB verso il NAS dura minuti, e una
// copia sincrona fermerebbe per tutto quel tempo il server e gli altri job.
export async function moveFile(src, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  const tmp = `${dest}.ondo-tmp`;
  try {
    await copyFile(src, tmp);
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => { /* best-effort */ });
    throw err;
  }
  await unlink(src);
}
