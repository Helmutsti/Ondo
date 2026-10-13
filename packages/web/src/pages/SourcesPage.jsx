import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw, Plus, Rss, MoreVertical, Trash2, ExternalLink, CalendarClock, CloudDownload, Gauge, SlidersHorizontal, TriangleAlert, X, WandSparkles } from 'lucide-react';
import { listSources, removeSource, syncSources, triggerJob, setSourceRules, getConfig, listVideos } from '../api/client.js';
import { openMetadataWizard } from '../lib/metadataWizard.js';
import { useTitle } from '../hooks/useTitle.js';
import { ActivityRow } from '../components/ActivityRow.jsx';
import { useActivity, refreshActivity } from '../lib/activityStore.js';
import { formatRelativeDate } from '../lib/format.js';
import { showToast } from '../lib/toast.js';
import { confirmDialog } from '../lib/dialog.js';

// Riconosce se l'input incollato è una PLAYLIST (→ nuova fonte) o un SINGOLO
// video (→ aggiunto alla libreria). Regola: la presenza di un `list=` (o di
// /playlist?) indica una playlist, ANCHE se l'URL contiene anche `v=` — è il
// caso di watch?v=…&list=…, il link che YouTube mostra mentre si guarda un
// video dentro una playlist. Per aggiungere un SINGOLO video basta incollare
// il link pulito senza list= (watch?v=…, youtu.be/…, id nudo, altri siti).
function looksLikePlaylist(input) {
  const s = input.trim();
  return /\/playlist\?/.test(s) || /[?&]list=/.test(s);
}

const CHECK_OPTIONS = [
  { value: null, label: 'Mai' },
  { value: '1h', label: 'Ogni ora' },
  { value: '6h', label: '6 ore' },
  { value: '12h', label: '12 ore' },
  { value: '24h', label: 'Ogni giorno' }
];
const CHECK_LABEL = { '1h': 'ogni ora', '6h': 'ogni 6 ore', '12h': 'ogni 12 ore', '24h': 'ogni giorno' };

function qualityLabel(q) {
  if (!q) return 'predefinita';
  if (q.kind === 'best') return 'massima';
  return `${q.height}p`;
}

// "tra 4 h", "tra 38 min": quanto manca a una data futura.
function formatIn(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 60_000) return 'a momenti';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `tra ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `tra ${h} h`;
  return `tra ${Math.round(h / 24)} giorni`;
}

function shortUrl(url) {
  return (url ?? '').replace(/^https?:\/\/(www\.)?/, '');
}

// Il riepilogo dell'ultimo controllo riuscito, in una riga.
function resultLine(r) {
  if (!r) return null;
  const parts = [`${r.newCount ?? 0} nuovi`];
  if (r.leftCount) parts.push(`${r.leftCount} usciti dalla playlist`);
  if (r.removed) parts.push(`${r.removed} spariti da YouTube`);
  if (r.restored) parts.push(`${r.restored} tornati disponibili`);
  if (r.autoQueued) parts.push(`${r.autoQueued} in download automatico`);
  return parts.join(' · ');
}

export function SourcesPage() {
  useTitle('Fonti');
  const [sources, setSources] = useState(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [rulesFor, setRulesFor] = useState(null);
  const addInputRef = useRef(null);
  const location = useLocation();
  const activity = useActivity();

  // "+" della barra mobile: arriva qui con state.focusAdd e trova il campo già
  // attivo, pronto per incollare il link (vedi MobileNav).
  useEffect(() => {
    if (location.state?.focusAdd) addInputRef.current?.focus();
  }, [location.key, location.state]);

  function reload() {
    return listSources().then((s) => { setSources(s); return s; }).catch((e) => setError(e.message));
  }
  useEffect(() => { reload(); }, []);

  // Quando un controllo o un'aggiunta finisce, i numeri delle fonti cambiano.
  const lastFinished = activity?.finished?.find((j) => ['syncSource', 'addSource', 'enrichSource'].includes(j.type))?.id;
  useEffect(() => { if (lastFinished) reload(); }, [lastFinished]);

  useEffect(() => {
    if (!menuFor) return undefined;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  // Il lavoro in corso o in coda su ciascuna fonte (dall'Attività).
  const busyBySource = useMemo(() => {
    const map = {};
    for (const j of activity?.active ?? []) {
      if (j.type !== 'syncSource' && j.type !== 'enrichSource') continue;
      const id = j.params?.sourceId;
      if (id && (!map[id] || j.status === 'running')) map[id] = j;
    }
    return map;
  }, [activity]);

  // Le aggiunte delle ultime 2 ore (playlist o video): restano qui sotto il
  // campo, con «Scarica» per i video appena aggiunti.
  const recentAdds = useMemo(() => {
    const since = new Date(Date.now() - 2 * 3_600_000).toISOString();
    return [...(activity?.active ?? []), ...(activity?.finished ?? [])]
      .filter((j) => (j.type === 'addSource' || j.type === 'addVideo') && (j.status === 'running' || j.status === 'queued' || (j.finishedAt ?? '') >= since))
      .slice(0, 5);
  }, [activity]);

  async function handleAdd(e) {
    e.preventDefault();
    const input = url.trim();
    if (!input) return;
    setUrl('');
    setError(null);
    try {
      await triggerJob(looksLikePlaylist(input) ? 'addSource' : 'addVideo', { url: input });
      refreshActivity();
    } catch (err) {
      setError(err.message);
    }
  }

  async function sync(sourceId) {
    try {
      await syncSources(sourceId);
      showToast(sourceId ? 'Controllo accodato.' : 'Controllo di tutte le fonti accodato.', 'info', 2500);
      refreshActivity();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function metadataFor(source) {
    setMenuFor(null);
    try {
      const all = await listVideos();
      const vids = all.filter((v) => v.sources?.some((x) => x.sourceId === source.id && !x.leftAt));
      openMetadataWizard({ label: `Fonte ${source.name}`, videos: vids, allLabel: 'Tutta la fonte' });
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function handleRemove(source) {
    setMenuFor(null);
    const ok = await confirmDialog({
      title: 'Rimuovere la fonte?',
      message: `Rimuovere "${source.name}"? I video già in libreria e i file scaricati non verranno toccati.`,
      confirmLabel: 'Rimuovi',
      danger: true
    });
    if (!ok) return;
    try {
      await removeSource(source.id);
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  const nextCheck = (sources ?? []).map((s) => s.nextCheckAt).filter(Boolean).sort()[0];

  return (
    <>
      <div className="page-head library-head">
        <div className="page-title-group">
          <h1>Fonti</h1>
          {sources && (
            <span className="page-sub">
              {sources.length} playlist{nextCheck ? ` · prossimo controllo ${formatIn(nextCheck)}` : ''}
            </span>
          )}
        </div>
        {sources?.length > 0 && (
          <div className="page-actions">
            <button className="btn" onClick={() => sync(null)}><RefreshCw size={14} />Controlla tutte ora</button>
          </div>
        )}
      </div>

      <div className="add-panel">
        <div className="add-eyebrow">Aggiungi una playlist o un singolo video</div>
        <form className="add-row" onSubmit={handleAdd}>
          <input
            ref={addInputRef}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Incolla una playlist YouTube, oppure un link o un id di un singolo video (anche Rumble…)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn btn-primary" type="submit"><Plus size={14} />Aggiungi</button>
        </form>
        <div className="add-hint">
          {url.trim()
            ? (looksLikePlaylist(url) ? 'Riconosciuto: playlist → diventa una fonte.' : 'Riconosciuto: video singolo → entra in libreria, senza scaricarlo.')
            : 'Playlist → nuova fonte · singolo video → aggiunto alla libreria. Solo metadati: il video lo scarichi dopo.'}
        </div>
        {recentAdds.length > 0 && (
          <div className="recent-adds">
            {recentAdds.map((j) => <ActivityRow key={j.id} job={j} />)}
          </div>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}

      {sources === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : sources.length === 0 ? (
        <div className="empty-state">Nessuna fonte: incolla qui sopra il link di una playlist.</div>
      ) : (
        <div className="source-list">
          {sources.map((s) => {
            const job = busyBySource[s.id];
            const failed = !job && s.lastError;
            return (
              <div key={s.id} className={`source-card${failed ? ' failed' : ''}`}>
                <div className="source-card-top">
                  <span className="source-icon"><Rss size={16} /></span>
                  <div className="source-main">
                    <div className="source-name discreet-text">{s.name}</div>
                    <div className="source-url discreet-text">Playlist YouTube · {shortUrl(s.url)}</div>
                  </div>
                  <div className="source-stats">
                    <span><b>{s.videoCount}</b>video</span>
                    <span><b>{s.downloaded}</b>scaricati</span>
                    <span><b>{s.toDownload}</b>da scaricare</span>
                  </div>
                  <button className="btn" disabled={!!job} onClick={() => sync(s.id)}>
                    <RefreshCw size={14} className={job?.status === 'running' ? 'spin' : undefined} />
                    {job ? (job.status === 'running' ? 'In corso…' : 'In coda') : 'Sincronizza ora'}
                  </button>
                  <span className="chip-menu-wrap">
                    <button className="icon-btn" aria-label="Altre azioni" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === s.id ? null : s.id); }}>
                      <MoreVertical size={16} />
                    </button>
                    {menuFor === s.id && (
                      <div className="menu-list source-menu" onClick={(e) => e.stopPropagation()}>
                        <button className="menu-item" onClick={() => { setMenuFor(null); setRulesFor(s); }}><SlidersHorizontal size={15} />Regole…</button>
                        <button className="menu-item" onClick={() => metadataFor(s)}><WandSparkles size={15} />Aggiorna metadati dei video…</button>
                        <a className="menu-item" href={s.url} target="_blank" rel="noreferrer" onClick={() => setMenuFor(null)}><ExternalLink size={15} />Apri su YouTube</a>
                        <button className="menu-item danger" onClick={() => handleRemove(s)}><Trash2 size={15} />Rimuovi fonte</button>
                      </div>
                    )}
                  </span>
                </div>
                <button type="button" className="source-rules" onClick={() => setRulesFor(s)} title="Cambia le regole">
                  <span><CalendarClock size={13} />Controllo: {s.rules.checkEvery ? CHECK_LABEL[s.rules.checkEvery] : 'solo a mano'}</span>
                  <span className={s.rules.autoDownload ? 'on' : ''}><CloudDownload size={13} />{s.rules.autoDownload ? 'Scarica i nuovi automaticamente' : 'Scaricamento: manuale'}</span>
                  <span><Gauge size={13} />Qualità: {qualityLabel(s.rules.quality)}</span>
                  <span className={`source-when${failed ? ' err' : ''}`}>
                    {failed
                      ? `Ultimo controllo fallito ${formatRelativeDate(s.lastAttemptAt) ?? ''}`
                      : `Controllata ${formatRelativeDate(s.lastCheckedAt) ?? 'mai'}${s.nextCheckAt ? ` · prossima ${formatIn(s.nextCheckAt)}` : ''}`}
                  </span>
                </button>
                {job?.status === 'running' && (
                  <div className="source-progress">
                    <div className="hint">{job.note?.phase === 'enriching' ? 'Verifica dei video e metadati…' : 'Lettura della playlist…'}{job.lastLine ? ` ${job.lastLine}` : ''}</div>
                    <div className={`progress-bar${job.progress == null ? ' indeterminate' : ''}`}>
                      <div style={job.progress != null ? { width: `${job.progress}%` } : undefined}></div>
                    </div>
                  </div>
                )}
                {failed && <div className="source-error">✘ {s.lastError.hint}{s.lastError.message ? <span> — {s.lastError.message}</span> : null}</div>}
                {!job && !failed && s.suspect && (
                  <div className="source-warn"><TriangleAlert size={13} />Ultimo elenco anomalo ({s.suspect.count} video invece di {s.suspect.lastGoodCount ?? '?'}): nessun video segnato come uscito.</div>
                )}
                {!job && !failed && !s.suspect && s.lastResult && <div className="source-result">✓ {resultLine(s.lastResult)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {rulesFor && (
        <RulesDrawer
          source={rulesFor}
          onClose={() => setRulesFor(null)}
          onSaved={(updated, queued) => {
            setRulesFor(null);
            setSources((list) => list.map((x) => (x.id === updated.id ? updated : x)));
            showToast(queued ? `Regole salvate: ${queued} video in coda per il download.` : 'Regole salvate.', 'success');
            if (queued) refreshActivity();
          }}
        />
      )}
    </>
  );
}

// Regole di una fonte, in un pannello laterale: la lista resta visibile.
function RulesDrawer({ source, onClose, onSaved }) {
  const [checkEvery, setCheckEvery] = useState(source.rules.checkEvery);
  const [autoDownload, setAutoDownload] = useState(source.rules.autoDownload);
  const [quality, setQuality] = useState(source.rules.quality ? JSON.stringify(source.rules.quality) : '');
  const [includeExisting, setIncludeExisting] = useState(false);
  const [levels, setLevels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getConfig().then((c) => setLevels((c.qualityLevels ?? []).filter((l) => l.kind === 'height'))).catch(() => {});
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const turningOn = autoDownload && !source.rules.autoDownload;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const rules = { checkEvery, autoDownload, quality: quality ? JSON.parse(quality) : null };
      const { source: updated, queued } = await setSourceRules(source.id, rules, turningOn && includeExisting);
      onSaved(updated, queued);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Regole di ${source.name}`}>
        <div className="drawer-head">
          <div>
            <h3>Regole · <span className="discreet-text">{source.name}</span></h3>
            <div className="page-sub">Playlist YouTube · {source.videoCount} video</div>
          </div>
          <button className="bulk-close" onClick={onClose} aria-label="Chiudi"><X size={18} /></button>
        </div>

        <div className="drawer-body">
          <section className="drawer-sec">
            <div className="setting-title"><CalendarClock size={15} /> Controllo automatico</div>
            <div className="setting-sub">Ogni quanto Ondo guarda se nella playlist ci sono video nuovi o usciti. Solo un elenco leggero: veloce, e i metadati dei video che hai già non si toccano.</div>
            <div className="seg-text" role="radiogroup" aria-label="Frequenza del controllo">
              {CHECK_OPTIONS.map((o) => (
                <button key={o.label} type="button" role="radio" aria-checked={checkEvery === o.value} className={checkEvery === o.value ? 'on' : ''} onClick={() => setCheckEvery(o.value)}>
                  {o.label}
                </button>
              ))}
            </div>
          </section>

          <section className="drawer-sec">
            <div className="setting-row">
              <div className="setting-text">
                <div className="setting-title"><CloudDownload size={15} /> Scarica automaticamente i nuovi video</div>
                <div className="setting-sub">Quando il controllo trova un video nuovo in questa playlist, lo scarica subito. Spento di default: attivalo solo per le playlist che usi come «da scaricare».</div>
              </div>
              <button type="button" role="switch" aria-checked={autoDownload} className={`switch${autoDownload ? ' on' : ''}`} onClick={() => setAutoDownload((v) => !v)} aria-label="Scaricamento automatico">
                <span className="switch-knob" />
              </button>
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label className="hint" htmlFor="src-quality">Qualità per questa fonte</label>
              <select id="src-quality" value={quality} onChange={(e) => setQuality(e.target.value)}>
                <option value="">Predefinita (dalle Impostazioni)</option>
                <option value={JSON.stringify({ kind: 'best' })}>Massima disponibile</option>
                {levels.map((l) => <option key={l.height} value={JSON.stringify({ kind: 'height', height: l.height })}>{l.label}</option>)}
              </select>
            </div>
            {turningOn && source.toDownload > 0 && (
              <div className="modal-radios" style={{ marginTop: 12 }}>
                <label className={`radio-row${!includeExisting ? ' selected' : ''}`}>
                  <input type="radio" checked={!includeExisting} onChange={() => setIncludeExisting(false)} />
                  <span className="radio-label">Solo i video che arriveranno da adesso</span>
                </label>
                <label className={`radio-row${includeExisting ? ' selected' : ''}`}>
                  <input type="radio" checked={includeExisting} onChange={() => setIncludeExisting(true)} />
                  <span className="radio-label">Anche i {source.toDownload} già presenti e non scaricati</span>
                </label>
              </div>
            )}
          </section>

          <section className="drawer-sec">
            <div className="setting-title"><TriangleAlert size={15} /> Video spariti dalla playlist</div>
            <div className="setting-sub">Un video che non compare per 2 controlli di fila esce dalla fonte, ma resta in libreria. Prima di segnarlo «sparito da YouTube» Ondo lo verifica da solo su YouTube; i «non disponibile» senza spiegazione vanno riconfermati a 6 ore di distanza. Il file e la scheda restano sempre.</div>
          </section>
          {error && <div className="notice error">{error}</div>}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>Salva regole</button>
        </div>
      </aside>
    </div>
  );
}
