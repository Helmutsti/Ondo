import { Router } from 'express';
import {
  listVideos,
  getVideo,
  listAvailable,
  listVideosByChannel,
  setVideoHidden,
  setVideoFavorite,
  deleteVideoFile,
  ignoreVideo,
  listIgnored,
  unignoreVideo,
  searchVideos,
  getRawMetadata,
  refreshVideoMetadata,
  prepareSingleVideoDownload,
  analyzeVideoDownload,
  triggerJob,
  getCreatorIndex
} from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';
import { toPublicVideo, toListVideo } from '../lib/publicVideo.js';

export const videosRouter = Router();

videosRouter.get('/videos', asyncRoute(async (req, res) => {
  // Il catalogo intero viene passato al frontend, che filtra per categoria
  // derivata client-side (i video sono già tutti in memoria, vedi CatalogPage/
  // Libreria). Nessun filtro server-side sullo stato: gli assi sono ortogonali.
  const [videos, avatars] = await Promise.all([listVideos(), getCreatorIndex()]);
  res.json(videos.map((v) => toListVideo(v, avatars)));
}));

videosRouter.get('/videos/available', asyncRoute(async (req, res) => {
  const [videos, avatars] = await Promise.all([listAvailable(), getCreatorIndex()]);
  res.json(videos.map((v) => toListVideo(v, avatars)));
}));

// Download one-off di un singolo video (M8): risolve/crea lo stub e, se c'è
// da scaricare, mette subito in coda il job — stesso orchestrazione di
// "Scarica video singolo" nel CLI. Route separata da /videos/:id perché non
// opera su un id già noto al client, ma su un URL incollato.
videosRouter.post('/videos/download-single', asyncRoute(async (req, res) => {
  // download !== false: default true (scarica subito). Il checkbox "Download
  // immediato" NON spuntato (M29) invia download:false → il video viene solo
  // aggiunto alla libreria (action 'added'), senza lanciare alcun job.
  const wantDownload = req.body?.download !== false;
  const result = await prepareSingleVideoDownload(req.body?.url, { download: wantDownload });
  if (result.action === 'download') {
    const { jobId } = triggerJob('downloadSingle', { videoId: result.videoId });
    res.json({ ...result, jobId });
    return;
  }
  res.json(result);
}));

// M55 — Analizza un download SENZA avviarlo, per far scegliere all'utente prima
// (confirm "elimina e ri-scarica" se già scaricato; scelta audio A/B se manca
// l'audio-only da fondere con la risoluzione massima). Body: { url } (nuovo/da
// link — crea lo stub come download-single, ma NON avvia il job) oppure
// { videoId } (video già in catalogo). Ritorna videoId/title/alreadyDownloaded/
// needsAudioChoice/maxVideoHeight/maxCombinedHeight.
videosRouter.post('/videos/analyze-download', asyncRoute(async (req, res) => {
  if (req.body?.videoId) {
    res.json(await analyzeVideoDownload(req.body.videoId));
    return;
  }
  res.json(await prepareSingleVideoDownload(req.body?.url, { download: true }));
}));

// M55 — Avvia il download di un video già in catalogo, con la strategia audio
// scelta e, opzionalmente, eliminando prima la copia esistente (ramo "Elimina e
// ri-scarica" del confirm). deleteFirst usa deleteVideoFile (file + riga
// d'archivio + reset a none), così il ri-download riparte pulito.
videosRouter.post('/videos/:id/download', asyncRoute(async (req, res) => {
  const audioStrategy = ['combined', 'merged'].includes(req.body?.audioStrategy) ? req.body.audioStrategy : undefined;
  // M56: tetto di risoluzione scelto dall'utente. number (>0) = cap; null =
  // "massima" (nessun cap); assente/undefined = usa il default di config.
  let maxHeight;
  if (req.body?.maxHeight === null) maxHeight = null;
  else if (Number.isFinite(req.body?.maxHeight) && req.body.maxHeight > 0) maxHeight = req.body.maxHeight;
  if (req.body?.deleteFirst === true) {
    await deleteVideoFile(req.params.id);
  }
  const { jobId } = triggerJob('downloadSingle', { videoId: req.params.id, audioStrategy, maxHeight });
  res.json({ jobId, videoId: req.params.id, audioStrategy: audioStrategy ?? null, maxHeight: maxHeight ?? null });
}));

videosRouter.get('/search', asyncRoute(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const [results, avatars] = await Promise.all([searchVideos(req.query.q, { limit }), getCreatorIndex()]);
  res.json(results.map((v) => toListVideo(v, avatars)));
}));

videosRouter.get('/channels/:key/videos', asyncRoute(async (req, res) => {
  const [videos, avatars] = await Promise.all([
    listVideosByChannel(req.params.key),
    getCreatorIndex()
  ]);
  res.json(videos.map((v) => toListVideo(v, avatars)));
}));

videosRouter.get('/videos/:id', asyncRoute(async (req, res) => {
  const [video, avatars] = await Promise.all([getVideo(req.params.id), getCreatorIndex()]);
  res.json(toPublicVideo(video, avatars));
}));

videosRouter.get('/videos/:id/metadata', asyncRoute(async (req, res) => {
  const raw = await getRawMetadata(req.params.id);
  res.json(raw ?? null);
}));

// "Aggiorna metadati" (M31): ri-scarica metadati + copertina; sui rimossi fa da
// ri-verifica (ripristina se il video è tornato, altrimenti non tocca nulla).
videosRouter.post('/videos/:id/metadata/refresh', asyncRoute(async (req, res) => {
  const [video, avatars] = await Promise.all([refreshVideoMetadata(req.params.id), getCreatorIndex()]);
  res.json(toPublicVideo(video, avatars));
}));

// Nasconde/mostra un video (asse `hidden` del modello a flag, M25) — sostituisce
// il vecchio /decision (new/pending/excluded, ciclo di revisione ora rimosso).
videosRouter.post('/videos/:id/hidden', asyncRoute(async (req, res) => {
  const [video, avatars] = await Promise.all([setVideoHidden(req.params.id, req.body?.hidden === true), getCreatorIndex()]);
  res.json(toPublicVideo(video, avatars));
}));

// Preferito (asse `favorite` del modello a flag, M43) — stesso pattern di /hidden.
videosRouter.post('/videos/:id/favorite', asyncRoute(async (req, res) => {
  const [video, avatars] = await Promise.all([setVideoFavorite(req.params.id, req.body?.favorite === true), getCreatorIndex()]);
  res.json(toPublicVideo(video, avatars));
}));

// «Ignora per sempre»: cancellato dalla libreria con i suoi file, e la sync non
// lo reinserisce più. Si annulla da Impostazioni › Video ignorati.
videosRouter.post('/videos/:id/ignore', asyncRoute(async (req, res) => {
  res.json(await ignoreVideo(req.params.id));
}));

videosRouter.get('/ignored', asyncRoute(async (req, res) => {
  res.json(await listIgnored());
}));

videosRouter.delete('/ignored/:id', asyncRoute(async (req, res) => {
  res.json(await unignoreVideo(req.params.id));
}));
