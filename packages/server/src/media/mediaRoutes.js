import express from 'express';
import path from 'node:path';
import { getPaths, ensureHlsStream, touchHlsStream } from '@catalog/core';

// express.static (pacchetto "send" sotto il cofano) supporta già Range
// requests/ETag out of the box — necessario per il seek nel player <video>.
export function mountMediaRoutes(app) {
  const paths = getPaths();
  app.use('/media/videos', express.static(paths.videosDir));
  app.use('/media/thumbnails', express.static(paths.thumbnailsDir));
  app.use('/media/avatars', express.static(paths.avatarsDir));

  // Versione HLS convertita al volo, per chi il file così com'è non lo legge
  // (iPhone/Safari: vedi streamService.js nel core). La playlist avvia la
  // conversione e risponde appena c'è il primo segmento; è di tipo EVENT, quindi
  // Safari la richiede di nuovo man mano e vede crescere il video. Mai in cache:
  // cambia finché la conversione non finisce.
  app.get('/media/hls/:id/index.m3u8', async (req, res) => {
    try {
      const dir = await ensureHlsStream(req.params.id);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dir, 'index.m3u8'));
    } catch (err) {
      res.status(500).type('text/plain').send(err.message);
    }
  });

  // I segmenti: solo nomi prodotti da ffmpeg (niente percorsi arbitrari).
  app.get('/media/hls/:id/:segment', (req, res) => {
    const { id, segment } = req.params;
    const dir = /^seg\d{5}\.ts$/.test(segment) ? touchHlsStream(id) : null;
    if (!dir) return res.sendStatus(404);
    res.setHeader('Content-Type', 'video/mp2t');
    res.sendFile(path.join(dir, segment), (err) => {
      if (err && !res.headersSent) res.sendStatus(404);
    });
  });
}
