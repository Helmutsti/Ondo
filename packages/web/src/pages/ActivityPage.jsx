import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert, Trash2 } from 'lucide-react';
import { clearJobs, getConfig, setParallel } from '../api/client.js';
import { ActivityRow } from '../components/ActivityRow.jsx';
import { useActivity, refreshActivity, recentBlock } from '../lib/activityStore.js';
import { useTitle } from '../hooks/useTitle.js';
import { confirmDialog } from '../lib/dialog.js';
import { showToast } from '../lib/toast.js';

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };

// Attività: tutti i lavori (download, controlli delle fonti, metadati), con il
// progresso letto dal server — c'è anche dopo un ricaricamento. Sostituisce la
// "Cronologia lavorazioni" in fondo a Sorgenti.
export function ActivityPage() {
  useTitle('Attività');
  const data = useActivity();
  const [parallel, setParallelState] = useState(null);
  const [parallelOptions, setParallelOptions] = useState([1, 2, 3, 4, 5, 6]);

  useEffect(() => {
    getConfig().then((c) => {
      setParallelState(c.parallel ?? data?.pool?.parallel ?? 1);
      if (Array.isArray(c.parallelLevels)) setParallelOptions(c.parallelLevels.map((l) => l.value ?? l));
    }).catch(() => {});
  }, []);

  const groups = useMemo(() => {
    const active = data?.active ?? [];
    const finished = data?.finished ?? [];
    const today = startOfToday();
    return {
      running: active.filter((j) => j.status === 'running'),
      queued: active.filter((j) => j.status === 'queued').sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)),
      failed: finished.filter((j) => j.status === 'failed'),
      done: finished.filter((j) => j.status === 'success' && (j.finishedAt ?? '') >= today)
    };
  }, [data]);
  const block = recentBlock(data);

  async function changeParallel(e) {
    const n = Number(e.target.value);
    try {
      await setParallel(n);
      setParallelState(n);
      refreshActivity();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function clearFinished() {
    const ok = await confirmDialog({
      title: 'Svuotare lo storico?',
      message: 'Toglie dall\'elenco tutti i lavori finiti (riusciti e falliti). I video e le fonti non vengono toccati.',
      confirmLabel: 'Svuota'
    });
    if (!ok) return;
    await clearJobs();
    refreshActivity();
  }

  if (!data) return <div className="empty-state"><span className="spinner"></span></div>;

  const section = (label, list, empty) => (
    <section className="act-section">
      <div className="section-label">{label} · {list.length}</div>
      {list.length === 0 ? <div className="side-empty" style={{ padding: '2px 0 8px' }}>{empty}</div> : list.map((j) => <ActivityRow key={j.id} job={j} />)}
    </section>
  );

  return (
    <>
      <div className="page-head library-head">
        <h1>Attività</h1>
        <div className="page-actions">
          {parallel != null && (
            <select value={parallel} onChange={changeParallel} aria-label="Lavori in parallelo">
              {[...new Set([...parallelOptions, parallel])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>In parallelo: {n}</option>)}
            </select>
          )}
          <button className="btn" onClick={clearFinished}><Trash2 size={14} />Svuota storico</button>
        </div>
      </div>

      {block && (
        <div className="act-warning big">
          <TriangleAlert size={18} />
          <div>
            <b>YouTube sta bloccando le richieste</b>
            <span>{block.error?.hint} I controlli e i metadati si sono fermati da soli invece di riempire la libreria di errori; riprovano al prossimo controllo.</span>
          </div>
          <Link to="/settings" className="btn small">Carica cookie</Link>
        </div>
      )}

      {section('In corso', groups.running, 'Niente in corso.')}
      {groups.queued.length > 0 && section('In coda', groups.queued, '')}
      {groups.failed.length > 0 && section('Problemi (ultime 24 ore)', groups.failed, '')}
      {section('Completati oggi', groups.done, 'Ancora niente oggi.')}
    </>
  );
}
