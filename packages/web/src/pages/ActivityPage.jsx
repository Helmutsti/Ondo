import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert, Trash2, WandSparkles } from 'lucide-react';
import { openMetadataWizard, useMetadataWizard } from '../lib/metadataWizard.js';
import { clearJobs, getConfig, setParallel, setMetadataParallel, listMetadataReviews } from '../api/client.js';
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
  const [metaParallel, setMetaParallel] = useState(null);
  const [parallelOptions, setParallelOptions] = useState([1, 2, 3, 4, 5, 6]);
  const [reviews, setReviews] = useState([]);
  const wizardOpen = !!useMetadataWizard();
  const lastFinished = data?.finished?.[0]?.id;
  // Le revisioni lasciate in sospeso dal wizard ("Chiedimi se diverso"):
  // si ricaricano quando finisce un lavoro e quando si chiude il wizard.
  useEffect(() => {
    if (wizardOpen) return;
    listMetadataReviews().then(setReviews).catch(() => {});
  }, [lastFinished, wizardOpen]);
  const reviewGroups = useMemo(() => {
    const map = new Map();
    for (const v of reviews) {
      const key = v.pendingReview?.label ?? 'Aggiorna metadati';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(v);
    }
    return [...map.entries()];
  }, [reviews]);

  useEffect(() => {
    getConfig().then((c) => {
      setParallelState(c.parallel ?? data?.pool?.parallel ?? 1);
      setMetaParallel(c.metadataParallel ?? 2);
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

  async function changeMetaParallel(e) {
    const n = Number(e.target.value);
    try {
      await setMetadataParallel(n);
      setMetaParallel(n);
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
            <select value={parallel} onChange={changeParallel} aria-label="Download in parallelo">
              {[...new Set([...parallelOptions, parallel])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>Download in parallelo: {n}</option>)}
            </select>
          )}
          {metaParallel != null && (
            <select value={metaParallel} onChange={changeMetaParallel} aria-label="Metadati in parallelo">
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Metadati in parallelo: {n}</option>)}
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
            <span>
              {block.error?.hint}{' '}
              {block.until
                ? `Controlli e metadati in pausa: riprovo alle ${new Date(block.until).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} (attesa crescente), oppure carica cookie aggiornati per ripartire prima. I download non sono coinvolti.`
                : 'I controlli e i metadati si sono fermati da soli invece di riempire la libreria di errori; riprovano al prossimo controllo.'}
            </span>
          </div>
          <Link to="/settings" className="btn small">Carica cookie</Link>
        </div>
      )}

      {section('In corso', groups.running, 'Niente in corso.')}
      {reviewGroups.length > 0 && (
        <section className="act-section">
          <div className="section-label">Da rivedere · {reviews.length}</div>
          {reviewGroups.map(([label, list]) => (
            <div key={label} className="review-banner">
              <WandSparkles size={18} />
              <div>
                <b>{list.length} video con metadati diversi da quelli salvati</b>
                <span className="discreet-text">Da «{label}»: decidi tu quali valori tenere.</span>
              </div>
              <button className="btn small" onClick={() => openMetadataWizard({ label, step: 'review', videos: list })}>Rivedi</button>
            </div>
          ))}
        </section>
      )}
      {groups.queued.length > 0 && section('In coda', groups.queued, '')}
      {groups.failed.length > 0 && section('Problemi (ultime 24 ore)', groups.failed, '')}
      {section('Completati oggi', groups.done, 'Ancora niente oggi.')}
    </>
  );
}
