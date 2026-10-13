import { Router } from 'express';
import { listSources, addSource, removeSource, setSourceRules, triggerJob } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const sourcesRouter = Router();

sourcesRouter.get('/sources', asyncRoute(async (req, res) => {
  res.json(await listSources());
}));

// Ingest a due fasi (M26): addSource popola subito i metadati leggeri
// (flat-playlist, istantaneo), poi si lancia il job enrichSource che arricchisce
// i metadati completi + copertine in background. Il jobId torna al client, che
// mostra la barra di avanzamento fino a fine arricchimento.
sourcesRouter.post('/sources', asyncRoute(async (req, res) => {
  const result = await addSource(req.body?.url);
  if (!result.alreadyExists) {
    const { jobId } = triggerJob('enrichSource', { sourceId: result.sourceId });
    res.json({ ...result, jobId });
    return;
  }
  res.json(result);
}));

sourcesRouter.delete('/sources/:id', asyncRoute(async (req, res) => {
  await removeSource(req.params.id);
  res.json({ ok: true });
}));

// Regole della fonte (controllo automatico, scaricamento automatico, qualità).
// includeExisting: con l'automatico acceso, accoda anche i video già presenti
// e non scaricati della fonte.
sourcesRouter.patch('/sources/:id/rules', asyncRoute(async (req, res) => {
  const { rules, includeExisting } = req.body ?? {};
  res.json(await setSourceRules(req.params.id, rules ?? {}, { includeExisting: includeExisting === true }));
}));

// Controllo di una fonte (body.sourceId) o di tutte: un job syncSource per
// fonte, così ciascuna ha il suo avanzamento e il suo esito in Attività, e la
// richiesta torna subito invece di aspettare l'elenco di ogni playlist.
sourcesRouter.post('/sync', asyncRoute(async (req, res) => {
  const { sourceId } = req.body ?? {};
  const ids = sourceId ? [sourceId] : (await listSources()).map((s) => s.id);
  const jobs = ids.map((id) => ({ sourceId: id, jobId: triggerJob('syncSource', { sourceId: id }).jobId }));
  res.json({ jobs });
}));
