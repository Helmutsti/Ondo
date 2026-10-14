import express, { Router } from 'express';
import {
  listProfiles,
  getProfile,
  listProfileVideos,
  getProfileIdForChannel,
  getCreatorIndex,
  renameProfile,
  setProfilePinned,
  mergeChannelsIntoProfile,
  splitChannelFromProfile,
  useChannelPhoto,
  setCustomPhoto,
  clearProfilePhoto,
  fetchChannelAvatar,
  MAX_CUSTOM_AVATAR_BYTES
} from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';
import { avatarUrl, toListVideo } from '../lib/publicVideo.js';

// Profili creator: uno o più canali della stessa persona, con nome e foto
// scelti a mano. Le statistiche (video, scaricati, spariti, spazio su disco)
// le calcola il core; qui si aggiungono solo gli URL delle foto.
export const profilesRouter = Router();

function toPublicProfile(p) {
  return {
    ...p,
    avatarUrl: avatarUrl(p.avatar),
    channels: p.channels.map((c) => ({ ...c, photoUrl: avatarUrl(c.photo) }))
  };
}

profilesRouter.get('/profiles', asyncRoute(async (req, res) => {
  res.json((await listProfiles()).map(toPublicProfile));
}));

profilesRouter.get('/profiles/:id', asyncRoute(async (req, res) => {
  res.json(toPublicProfile(await getProfile(req.params.id)));
}));

profilesRouter.get('/profiles/:id/videos', asyncRoute(async (req, res) => {
  const [videos, index] = await Promise.all([listProfileVideos(req.params.id), getCreatorIndex()]);
  res.json(videos.map((v) => toListVideo(v, index)));
}));

// Nome e "fissato in sidebar". Un nome vuoto torna a seguire quello del canale.
profilesRouter.patch('/profiles/:id', asyncRoute(async (req, res) => {
  const { name, pinned } = req.body ?? {};
  let profile;
  if (name !== undefined) profile = await renameProfile(req.params.id, name);
  if (pinned !== undefined) profile = await setProfilePinned(req.params.id, pinned === true);
  res.json(toPublicProfile(profile ?? await getProfile(req.params.id)));
}));

// Unisce dei canali al profilo (li toglie dai profili in cui erano).
profilesRouter.post('/profiles/:id/channels', asyncRoute(async (req, res) => {
  const keys = Array.isArray(req.body?.channelKeys) ? req.body.channelKeys.filter((k) => typeof k === 'string') : [];
  res.json(toPublicProfile(await mergeChannelsIntoProfile(req.params.id, keys)));
}));

// Separa un canale in un profilo nuovo; risponde con il profilo nuovo.
profilesRouter.post('/profiles/:id/channels/:key/split', asyncRoute(async (req, res) => {
  res.json(toPublicProfile(await splitChannelFromProfile(req.params.id, req.params.key)));
}));

// Foto del profilo = quella (già scaricata) di un suo canale.
profilesRouter.post('/profiles/:id/avatar', asyncRoute(async (req, res) => {
  const channelKey = typeof req.body?.channelKey === 'string' ? req.body.channelKey : null;
  if (!channelKey) return res.status(400).json({ error: 'channelKey mancante.' });
  res.json(toPublicProfile(await useChannelPhoto(req.params.id, channelKey)));
}));

// Foto del profilo = immagine caricata (corpo grezzo, Content-Type dell'immagine).
profilesRouter.put(
  '/profiles/:id/avatar',
  express.raw({ type: () => true, limit: MAX_CUSTOM_AVATAR_BYTES + 1024 }),
  asyncRoute(async (req, res) => {
    res.json(toPublicProfile(await setCustomPhoto(req.params.id, req.body, req.headers['content-type'])));
  })
);

profilesRouter.delete('/profiles/:id/avatar', asyncRoute(async (req, res) => {
  res.json(toPublicProfile(await clearProfilePhoto(req.params.id)));
}));

// Scarica da YouTube la foto di un canale. Solo su richiesta, dalla finestra
// "Foto del profilo": niente più scaricamento automatico a fine sync.
profilesRouter.post('/channels/:key/avatar/fetch', asyncRoute(async (req, res) => {
  const record = await fetchChannelAvatar(req.params.key);
  res.json({ ...record, photoUrl: avatarUrl({ localPath: record.localPath, version: record.fetchedAt }) });
}));

// Vecchi link /channels/:key → il profilo che contiene quel canale.
profilesRouter.get('/channels/:key/profile', asyncRoute(async (req, res) => {
  const id = await getProfileIdForChannel(req.params.key);
  if (!id) return res.status(404).json({ error: 'Nessun profilo per questo canale.' });
  res.json({ id });
}));
