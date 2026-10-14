import express, { Router } from 'express';
import {
  getPaths, getCookiesStatus, saveCookiesFile, deleteCookiesFile,
  getQuality, setQuality, qualityLabel, sameQuality, QUALITY_LEVELS,
  getJobParallelism,
  getMetadataParallelism,
  setMetadataParallelism, setJobParallelism
} from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const configRouter = Router();

// Sola lettura delle impostazioni rilevanti per la UI: la radice della libreria
// attiva, la cartella video (sempre <libreria>/videos), e la qualità predefinita di
// download (stesso menu della CLI — QUALITY_LEVELS è la fonte unica, il web non
// lo reimplementa).
configRouter.get(
  '/config',
  asyncRoute(async (req, res) => {
    const paths = getPaths();
    const quality = getQuality();
    res.json({
      // M97 — `mediaRootResolved` non esiste più: data/media/ è sparita,
      // copertine e avatar stanno in cima alla libreria. Si espone la radice
      // della libreria, che è l'informazione utile ora.
      libraryRoot: paths.libraryRoot,
      videosDirResolved: paths.videosDir,
      cookies: getCookiesStatus(),
      quality,
      qualityLevels: QUALITY_LEVELS.map((q) => ({
        kind: q.kind,
        height: q.height,
        label: qualityLabel(q),
        current: sameQuality(q, quality)
      })),
      parallel: getJobParallelism(),
      metadataParallel: getMetadataParallelism()
    });
  })
);

// Cookie YouTube (<config>/cookies.txt): corpo grezzo del file .txt esportato dal
// browser (stesso pattern del ripristino backup — middleware raw a livello di
// route). Nessun riavvio richiesto: il prossimo comando yt-dlp lo vede subito.
configRouter.post(
  '/config/cookies',
  express.text({ type: () => true, limit: '5mb' }),
  asyncRoute(async (req, res) => {
    res.json(saveCookiesFile(req.body));
  })
);

configRouter.delete(
  '/config/cookies',
  asyncRoute(async (req, res) => {
    res.json(deleteCookiesFile());
  })
);

// Qualità predefinita dei download (vale per i futuri, non tocca quelli già
// scaricati). Il body è uno dei { kind, height } di QUALITY_LEVELS, così come
// li ha ricevuti da GET /config — nessuna logica di parsing qui, la valida
// setQuality (core/src/quality.js).
configRouter.post(
  '/config/quality',
  asyncRoute(async (req, res) => {
    const { kind, height } = req.body ?? {};
    res.json(setQuality({ kind, height: height ?? null }));
  })
);

// Quanti download/job girano insieme (default 1, "un download per volta" —
// stesso menu della CLI, vedi ondo.js setParallel). nudgeJobPool() dopo
// l'update fa partire subito i job in coda se il tetto è stato alzato.
configRouter.post(
  '/config/parallel',
  asyncRoute(async (req, res) => {
    // M96 — un solo punto di scrittura nel core (scrive e fa il nudge).
    res.json({ parallel: setJobParallelism(req.body?.parallel) });
  })
);

// Quanti lavori "leggeri" (controlli delle fonti, metadati) girano insieme,
// separati dai download: è anche quanti video il wizard elabora alla volta.
configRouter.post(
  '/config/metadata-parallel',
  asyncRoute(async (req, res) => {
    res.json({ metadataParallel: setMetadataParallelism(req.body?.metadataParallel) });
  })
);
