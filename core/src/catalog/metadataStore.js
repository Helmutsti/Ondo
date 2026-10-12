// I metadati grezzi di yt-dlp (l'.info.json di ogni video), nella tabella
// `metadata` di data/libreria.db — erano data/metadata.json.
//
// Niente più cache in memoria: si leggono per id quando servono (la scheda di
// un video, l'esportazione), che è quasi mai rispetto al resto del catalogo. Il
// file intero arrivava a ~90 MB e veniva letto, tenuto in memoria e riscritto
// per intero a ogni video scaricato; adesso una scrittura è una riga.

import { getDb, writeTransaction } from './db.js';

export async function readMetadata(id) {
  const row = getDb().prepare('SELECT data FROM metadata WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}

// Rimuove i metadati grezzi di un video (usata dalla cancellazione totale,
// M-punto 11): non fallisce se l'id non c'è. Chiamata dentro una modifica del
// catalogo, fa parte della sua stessa transazione (vedi db.js).
export async function deleteMetadata(id) {
  await writeTransaction((db) => {
    db.prepare('DELETE FROM metadata WHERE id = ?').run(id);
  });
}

export async function setMetadata(id, info) {
  // automatic_captions elenca URL di sottotitoli auto-tradotti in 150+ lingue:
  // quasi mai utile, gonfia i metadati di centinaia di KB per video. Rimosso qui,
  // punto unico di scrittura, così ogni chiamante ne beneficia senza doverci pensare.
  const { automatic_captions, ...trimmed } = info;
  await writeTransaction((db) => {
    db.prepare('INSERT OR REPLACE INTO metadata (id, data) VALUES (?, ?)').run(id, JSON.stringify(trimmed));
  });
}
