import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Activity, ArrowRight, TriangleAlert } from 'lucide-react';
import { useActivity, recentBlock } from '../lib/activityStore.js';
import { ActivityRow } from './ActivityRow.jsx';

// Indicatore nella barra in alto: quanti lavori sono in corso, con la barra
// del progresso medio; al click un pannello con i lavori attivi e gli ultimi
// finiti, senza lasciare la pagina.
export function ActivityIndicator() {
  const data = useActivity();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();
  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const active = data?.active ?? [];
  const running = active.filter((j) => j.status === 'running');
  const withPct = running.filter((j) => j.progress != null);
  const avg = withPct.length ? withPct.reduce((n, j) => n + j.progress, 0) / withPct.length : null;
  const failedRecent = (data?.finished ?? []).filter((j) => j.status === 'failed').slice(0, 3);
  const block = recentBlock(data);
  const recent = (data?.finished ?? []).slice(0, 4);

  return (
    <div className="act-indicator" ref={ref}>
      <button
        type="button"
        className={`act-pill${active.length ? ' busy' : ''}${block ? ' warn' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Attività"
      >
        {block ? <TriangleAlert size={14} /> : <Activity size={14} />}
        <span className="act-pill-label">
          {active.length ? `${running.length || active.length} ${running.length ? 'in corso' : 'in coda'}` : 'Attività'}
        </span>
        {active.length > 0 && (
          <span className="act-pill-bar"><span style={{ width: `${avg ?? 35}%` }} className={avg == null ? 'indeterminate' : ''} /></span>
        )}
      </button>
      {open && (
        <div className="act-panel" role="dialog" aria-label="Attività">
          <div className="act-panel-head">
            <b>Attività</b>
            <Link to="/activity" className="act-panel-all">Apri tutto <ArrowRight size={13} /></Link>
          </div>
          {block && (
            <div className="act-warning">
              <TriangleAlert size={16} />
              <div><b>YouTube sta bloccando le richieste</b><span>{block.error?.hint}</span></div>
              <Link to="/settings" className="btn small">Cookie…</Link>
            </div>
          )}
          {active.length === 0 && failedRecent.length === 0 && recent.length === 0 && (
            <div className="side-empty" style={{ padding: '14px 4px' }}>Nessun lavoro nelle ultime 24 ore.</div>
          )}
          {active.slice(0, 6).map((j) => <ActivityRow key={j.id} job={j} compact />)}
          {active.length > 6 && <div className="act-more">e altri {active.length - 6} in coda</div>}
          {active.length === 0 && recent.map((j) => <ActivityRow key={j.id} job={j} compact />)}
          {active.length > 0 && failedRecent.map((j) => <ActivityRow key={j.id} job={j} compact />)}
        </div>
      )}
    </div>
  );
}
