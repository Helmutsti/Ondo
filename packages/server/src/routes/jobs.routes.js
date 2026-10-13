import { Router } from 'express';
import { triggerJob, getJob, listJobs, listActivity, getPoolStatus, deleteJob, cancelJob, clearJobs, onJobLog, onJobProgress, onJobStatus } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';
import { toPublicJob, toPublicJobs } from '../lib/publicJob.js';

export const jobsRouter = Router();

jobsRouter.get('/jobs', asyncRoute(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(await toPublicJobs(listJobs(limit)));
}));

// Attività: tutti i job attivi (senza tetto) e i terminati delle ultime 24 ore
// (o da ?since=ISO), in forma leggera — l'ultima riga di log invece di tutto il
// log. `videos` collega ogni video in download al suo job, così le card
// mostrano il progresso anche dopo un ricaricamento della pagina.
const FINISHED_LIMIT = 150;
function lightJob(j) {
  const { logLines, ...rest } = j;
  return { ...rest, lastLine: logLines?.at(-1) ?? null, logCount: logLines?.length ?? 0 };
}
jobsRouter.get('/activity', asyncRoute(async (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { active, finished } = listActivity({ since });
  const [pubActive, pubFinished] = await Promise.all([
    toPublicJobs(active.map(lightJob)),
    toPublicJobs(finished.slice(0, FINISHED_LIMIT).map(lightJob))
  ]);
  const videos = {};
  for (const j of active) {
    const videoId = j.params?.videoId ?? j.note?.videoId;
    if (videoId && (j.type === 'downloadSingle' || j.type === 'quickDownload')) {
      videos[videoId] = { jobId: j.id, status: j.status, progress: j.progress ?? null, queuePosition: j.queuePosition };
    }
  }
  res.json({ active: pubActive, finished: pubFinished, finishedTotal: finished.length, videos, pool: getPoolStatus() });
}));

jobsRouter.post('/jobs', asyncRoute(async (req, res) => {
  const { type, params } = req.body ?? {};
  res.json(triggerJob(type, params));
}));

// Svuota lo storico (tutti i job terminati). Registrata prima di
// "/jobs/:id" cosi' il DELETE senza id non viene catturato dalla rotta con
// parametro.
jobsRouter.delete('/jobs', asyncRoute(async (req, res) => {
  res.json(clearJobs());
}));

jobsRouter.delete('/jobs/:id', asyncRoute(async (req, res) => {
  res.json(deleteJob(req.params.id));
}));

// Interruzione manuale (M51): solo per i job che la dichiarano interrompibile
// (downloadSingle/downloadPending) — cancelJob() rifiuta gli altri stati/tipi
// con un errore chiaro, propagato come 400 da asyncRoute.
jobsRouter.post('/jobs/:id/cancel', asyncRoute(async (req, res) => {
  res.json(cancelJob(req.params.id));
}));

jobsRouter.get('/jobs/:id', asyncRoute(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job non trovato: "${req.params.id}"` });
    return;
  }
  res.json(await toPublicJob(job));
}));

// Bridge SSE sugli eventi in tempo reale di jobManager (log/progress/status)
// — lo stesso EventEmitter a cui il CLI si iscrive direttamente essendo nello
// stesso processo. Un client che si collega dopo l'avvio riceve prima lo
// storico accumulato (job.logLines), poi gli eventi live.
jobsRouter.get('/jobs/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job non trovato: "${req.params.id}"` });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('status', job.status);
  for (const line of job.logLines) send('log', line);

  function cleanup() {
    offLog();
    offProgress();
    offStatus();
  }

  const offLog = onJobLog(req.params.id, (line) => send('log', line));
  const offProgress = onJobProgress(req.params.id, (pct) => send('progress', pct));
  const offStatus = onJobStatus(req.params.id, (status) => {
    send('status', status);
    if (status === 'success' || status === 'failed') {
      cleanup();
      res.end();
    }
  });

  req.on('close', cleanup);

  if (job.status === 'success' || job.status === 'failed') {
    cleanup();
    res.end();
  }
});
