import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Clock, CircleCheck, CircleX, RefreshCw, X, FileText, CloudDownload } from 'lucide-react';
import { cancelJob, getJob, triggerJob } from '../api/client.js';
import { JOB_LABEL, isDownloadJob, refreshActivity } from '../lib/activityStore.js';
import { startDownload } from '../lib/downloadActions.js';
import { showToast } from '../lib/toast.js';
import { formatRelativeDate } from '../lib/format.js';

const ADD_VIDEO_LABEL = {
  added: 'aggiunto alla libreria',
  'already-present': 'già in libreria',
  'already-downloaded': 'già scaricato',
  'already-downloading': 'già in download'
};

const INTERRUPTIBLE = new Set(['downloadSingle', 'downloadPending', 'quickDownload']);

function jobTitle(job) {
  if (job.title) return job.title;
  if (job.type === 'enrichSource') return job.params?.sourceId ? 'Arricchimento di una fonte' : 'Arricchimento di tutte le fonti';
  if (job.type === 'addSource' || job.type === 'addVideo') return job.params?.url ?? '—';
  return JOB_LABEL[job.type] ?? job.type;
}

// Il riepilogo di un job finito, in una riga.
function outcome(job) {
  const s = job.summary;
  if (!s) return null;
  if (job.type === 'syncSource') {
    const parts = [`${s.newCount ?? 0} nuovi`];
    if (s.leftCount) parts.push(`${s.leftCount} usciti`);
    if (s.removed) parts.push(`${s.removed} spariti`);
    if (s.restored) parts.push(`${s.restored} tornati`);
    if (s.autoQueued) parts.push(`${s.autoQueued} in download automatico`);
    return parts.join(' · ');
  }
  if (job.type === 'enrichSource') return `${s.enriched ?? 0} arricchiti${s.failed ? ` · ${s.failed} falliti` : ''}`;
  if (job.type === 'addSource') return s.alreadyExists ? 'fonte già presente' : `${s.newCount ?? 0} video trovati`;
  if (job.type === 'addVideo') return ADD_VIDEO_LABEL[s.action] ?? s.action ?? null;
  if (job.type === 'downloadPending') return `${s.downloaded ?? 0} scaricati${s.failed ? ` · ${s.failed} falliti` : ''}`;
  return null;
}

// Una riga della pagina/pannello Attività. compact = pannello in alto.
export function ActivityRow({ job, compact = false }) {
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState(false);
  const running = job.status === 'running';
  const queued = job.status === 'queued';
  const failed = job.status === 'failed';
  const Icon = running ? Download : queued ? Clock : failed ? CircleX : CircleCheck;
  const iconCls = running ? 'run' : queued ? 'wait' : failed ? 'fail' : 'ok';
  const videoId = job.params?.videoId ?? job.note?.videoId ?? job.summary?.videoId ?? null;

  let sub = JOB_LABEL[job.type] ?? job.type;
  if (job.params?.auto) sub += ' automatico';
  if (queued) sub += job.queuePosition ? ` · in coda (${job.queuePosition}°)` : ' · in coda';
  else if (running) sub += job.note?.phase === 'enriching' ? ' · verifica e metadati' : (job.lastLine ? ` · ${job.lastLine}` : '');
  else if (failed) sub += ` · ${job.error?.hint ?? job.error?.message ?? 'errore sconosciuto'}`;
  else if (outcome(job)) sub += ` · ${outcome(job)}`;

  async function cancel() {
    setBusy(true);
    try { await cancelJob(job.id); showToast('Interrotto.', 'info', 2000); } catch (e) { showToast(e.message, 'error'); }
    setBusy(false);
    refreshActivity();
  }

  async function retry() {
    if (isDownloadJob(job) && videoId) {
      await startDownload(videoId, { triggerJob, onSettled: refreshActivity, title: job.title });
    } else if (job.type === 'syncSource' || job.type === 'enrichSource' || job.type === 'addSource' || job.type === 'addVideo') {
      await triggerJob(job.type, job.params);
      showToast('Riaccodato.', 'info', 2000);
    }
    refreshActivity();
  }

  async function toggleLog() {
    if (log) { setLog(null); return; }
    try { setLog((await getJob(job.id)).logLines ?? []); } catch (e) { setLog([e.message]); }
  }

  const canCancel = queued || (running && INTERRUPTIBLE.has(job.type));
  const canRetry = failed && (videoId || ['syncSource', 'enrichSource', 'addSource', 'addVideo'].includes(job.type));
  // Video appena aggiunto alla libreria: lo si scarica da qui, senza cercarlo.
  const addedVideo = job.type === 'addVideo' && job.status === 'success' && (job.summary?.action === 'added' || job.summary?.action === 'already-present') && job.summary?.videoId;

  return (
    <div className={`act-row ${iconCls}${compact ? ' compact' : ''}`}>
      <span className={`act-icon ${iconCls}`}><Icon size={15} /></span>
      <div className="act-body" onClick={compact ? undefined : toggleLog} role={compact ? undefined : 'button'}>
        <div className="act-title discreet-text">
          {videoId ? <Link to={`/videos/${encodeURIComponent(videoId)}`} onClick={(e) => e.stopPropagation()}>{jobTitle(job)}</Link> : jobTitle(job)}
        </div>
        <div className={`act-sub${failed ? ' err' : ''} discreet-text`}>{sub}</div>
        {running && (
          <div className={`progress-bar act-progress${job.progress == null ? ' indeterminate' : ''}`}>
            <div style={job.progress != null ? { width: `${job.progress}%` } : undefined}></div>
          </div>
        )}
        {!running && !queued && job.finishedAt && (
          <div className="act-time">
            {formatRelativeDate(job.finishedAt)}
            {!compact && job.logCount > 0 && <span className="act-log-link"><FileText size={11} />{log ? 'nascondi log' : 'log'}</span>}
          </div>
        )}
        {log && (
          <div className="job-log act-log discreet-text" onClick={(e) => e.stopPropagation()}>
            {log.map((line, i) => <div key={i} className="line">{line}</div>)}
          </div>
        )}
      </div>
      <div className="act-actions">
        {addedVideo && !compact && (
          <button className="btn small" onClick={() => startDownload(job.summary.videoId, { triggerJob, onSettled: refreshActivity, title: job.title })}>
            <CloudDownload size={13} />Scarica
          </button>
        )}
        {canRetry && (
          <button className="icon-btn small-icon" title="Riprova" aria-label="Riprova" disabled={busy} onClick={retry}><RefreshCw size={14} /></button>
        )}
        {canCancel && (
          <button className="icon-btn small-icon" title="Interrompi" aria-label="Interrompi" disabled={busy} onClick={cancel}><X size={14} /></button>
        )}
      </div>
    </div>
  );
}

