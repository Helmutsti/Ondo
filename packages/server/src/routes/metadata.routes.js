import { Router } from 'express';
import {
  triggerJob, listPendingReviews, resolveReview, setVideoField, setFieldLock, restoreHistoryEntry,
  getCreatorIndex, FIELD_NAMES, DEFAULT_FIELD_RULES, EDITABLE_FIELDS
} from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';
import { toPublicVideo } from '../lib/publicVideo.js';

// Wizard dei metadati (redesign R4): avvio dell'aggiornamento, revisioni,
// modifiche a mano, blocchi dei campi e cronologia.
export const metadataRouter = Router();

metadataRouter.get('/metadata/fields', (req, res) => {
  res.json({ fields: FIELD_NAMES, defaults: DEFAULT_FIELD_RULES, editable: EDITABLE_FIELDS });
});

// body: { videoIds, fields, rules, label } → un job "updateMetadata".
metadataRouter.post('/metadata/update', asyncRoute(async (req, res) => {
  const { videoIds, fields, rules, label } = req.body ?? {};
  const ids = Array.isArray(videoIds) ? videoIds.filter((x) => typeof x === 'string') : [];
  if (!ids.length) return res.status(400).json({ error: 'Nessun video da aggiornare.' });
  const chosen = Array.isArray(fields) ? fields.filter((f) => f === 'presence' || FIELD_NAMES.includes(f)) : FIELD_NAMES;
  res.json(triggerJob('updateMetadata', { videoIds: ids, fields: chosen, rules: rules ?? {}, label: typeof label === 'string' ? label : null }));
}));

metadataRouter.get('/metadata/reviews', asyncRoute(async (req, res) => {
  const [videos, index] = await Promise.all([listPendingReviews(), getCreatorIndex()]);
  res.json(videos.map((v) => toPublicVideo(v, index)));
}));

async function respond(res, video) {
  res.json(toPublicVideo(video, await getCreatorIndex()));
}

metadataRouter.post('/videos/:id/review', asyncRoute(async (req, res) => {
  const { choices, lock } = req.body ?? {};
  await respond(res, await resolveReview(req.params.id, { choices: choices ?? {}, lock: Array.isArray(lock) ? lock : [] }));
}));

metadataRouter.patch('/videos/:id/fields', asyncRoute(async (req, res) => {
  const { field, value } = req.body ?? {};
  await respond(res, await setVideoField(req.params.id, field, value));
}));

metadataRouter.post('/videos/:id/locks', asyncRoute(async (req, res) => {
  const { field, locked } = req.body ?? {};
  await respond(res, await setFieldLock(req.params.id, field, locked === true));
}));

metadataRouter.post('/videos/:id/history/:entryId/restore', asyncRoute(async (req, res) => {
  await respond(res, await restoreHistoryEntry(req.params.id, req.params.entryId));
}));
