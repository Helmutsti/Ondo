import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Star, SquareCheck, LayoutGrid, List, CloudDownload, FileDown, ListPlus, EyeOff, Eye, X, Archive, CheckCheck } from 'lucide-react';
import { listVideos, listSources, listProfiles, setHidden, setFavorite, triggerJob, refreshMetadata } from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { ProblemGroups } from '../components/ProblemGroups.jsx';
import { SkeletonGrid, SkeletonRows } from '../components/Skeletons.jsx';
import { useActivity } from '../lib/activityStore.js';
import { useTitle } from '../hooks/useTitle.js';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';
import { startDownload, startBulkDownload } from '../lib/downloadActions.js';
import { countViews, viewByValue, visibleViews } from '../lib/libraryFilters.js';
import { useShowHiddenFilter } from '../lib/hiddenFilterStore.js';
import { useIncremental } from '../hooks/useIncremental.js';
import { statusColor } from '../lib/status.js';
import { addToQueue } from '../lib/queueStore.js';
import { showToast } from '../lib/toast.js';
import { openMetadataWizard } from '../lib/metadataWizard.js';

const SINGLE = '__single__';
const LAYOUT_KEY = 'ondo:libraryLayout';

function loadLayout() {
  try { return localStorage.getItem(LAYOUT_KEY) === 'row' ? 'row' : 'grid'; } catch { return 'grid'; }
}

// Libreria (ex Home): tutto il catalogo, con le viste esplicite in chip e i
// filtri nell'URL — tornando indietro da un video li ritrovi come li avevi
// lasciati. "Nascosti" sostituisce la vecchia pagina Archiviati.
export function CatalogPage() {
  const [params, setParams] = useSearchParams();
  const showHidden = useShowHiddenFilter();
  const view = viewByValue(params.get('vista'), showHidden);
  const sort = params.get('ordine') ?? 'uploadDate';
  const creator = params.get('creator') ?? '';
  const source = params.get('fonte') ?? '';

  const [videos, setVideos] = useState(null);
  const [sources, setSources] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [error, setError] = useState(null);
  const [layout, setLayout] = useState(loadLayout);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const lastClicked = useRef(null);
  useTitle('Libreria');

  function reload() {
    listVideos().then(setVideos).catch((e) => setError(e.message));
  }
  useEffect(reload, []);
  // Un lavoro appena finito (download, controllo di una fonte) cambia lo stato
  // dei video: si ricarica l'elenco, anche se l'ha avviato un'altra pagina o
  // lo scheduler.
  const lastFinished = useActivity()?.finished?.[0]?.id;
  useEffect(() => { if (lastFinished) reload(); }, [lastFinished]);
  useEffect(() => { listSources().then(setSources).catch(() => {}); }, []);
  useEffect(() => { listProfiles().then(setProfiles).catch(() => {}); }, []);

  function setParam(key, value) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  }

  function chooseLayout(l) {
    setLayout(l);
    try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* solo per questa scheda */ }
  }

  // Creator e fonte restringono anche i conteggi delle chip: il numero sulla
  // chip è sempre quello che compare cliccandola.
  const scoped = useMemo(() => {
    let list = videos ?? [];
    if (creator) list = list.filter((v) => v.channel?.profileId === creator);
    if (source) list = list.filter((v) => (source === SINGLE ? !v.sources?.length : v.sources?.some((s) => s.sourceId === source)));
    return list;
  }, [videos, creator, source]);

  const counts = useMemo(() => countViews(scoped), [scoped]);

  const filtered = useMemo(() => {
    let list = scoped.filter(view.fn);
    return sortVideos(list, sort);
  }, [scoped, view, sort]);
  // Si allunga scorrendo (hooks/useIncremental.js); da capo a ogni cambio di vista o filtro.
  const page = useIncremental(filtered, `${view.value}|${sort}|${creator}|${source}|${layout}`);


  // Cambiando vista o filtri la selezione riparte da zero: selezionare qui e
  // agire su video che non si vedono più sarebbe una sorpresa.
  useEffect(() => { setSelected(new Set()); lastClicked.current = null; }, [view.value, creator, source]);

  useEffect(() => {
    if (!selectMode) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') exitSelect(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectMode]);

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
    lastClicked.current = null;
  }

  // Click = aggiungi/togli; Shift+click = tutto l'intervallo dall'ultimo click.
  function toggleSelect(id, e) {
    if (!selectMode) setSelectMode(true);
    const ids = filtered.map((v) => v.id);
    const index = ids.indexOf(id);
    // Letto ORA: l'aggiornamento di stato qui sotto gira dopo che lastClicked
    // è già passato al video appena cliccato.
    const anchor = e?.shiftKey ? lastClicked.current : null;
    setSelected((prev) => {
      const next = new Set(prev);
      if (anchor != null) {
        const from = ids.indexOf(anchor);
        if (from !== -1) {
          const [a, b] = from < index ? [from, index] : [index, from];
          for (const x of ids.slice(a, b + 1)) next.add(x);
          return next;
        }
      }
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    lastClicked.current = id;
  }

  function selectAll() {
    setSelectMode(true);
    setSelected(new Set(filtered.map((v) => v.id)));
  }

  const selectedVideos = filtered.filter((v) => selected.has(v.id));
  const allSelected = filtered.length > 0 && selectedVideos.length === filtered.length;
  const downloadable = selectedVideos.filter((v) => v.presence === 'present' && v.download === 'none');
  const queueable = selectedVideos.filter((v) => v.download === 'downloaded');

  async function bulkDownload() {
    const ids = downloadable.map((v) => v.id);
    exitSelect();
    await startBulkDownload(ids, { onSettled: reload });
  }

  // Il wizard dei metadati sulla selezione: campi, regole e revisione.
  function bulkMetadata() {
    const list = selectedVideos;
    exitSelect();
    openMetadataWizard({ label: `${list.length} video selezionati`, videos: list, allLabel: 'Tutti i selezionati' });
  }

  function bulkQueue() {
    for (const v of queueable) addToQueue(v);
    showToast(`${queueable.length} video aggiunti alla coda.`, 'success', 2500);
    exitSelect();
  }

  async function bulkHide(hidden) {
    const list = selectedVideos;
    exitSelect();
    setBusy(true);
    try {
      for (const v of list) await setHidden(v.id, hidden);
      showToast(hidden ? `${list.length} video nascosti.` : `${list.length} video di nuovo visibili.`, 'success');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      reload();
    }
  }

  async function handleAction(id, kind) {
    try {
      if (kind === 'download') {
        const title = filtered.find((v) => v.id === id)?.title;
        await startDownload(id, { triggerJob, onSettled: reload, title });
        return;
      }
      if (kind === 'metadata') {
        await refreshMetadata(id);
        reload();
        return;
      }
      if (kind === 'favorite' || kind === 'unfavorite') {
        await setFavorite(id, kind === 'favorite');
        reload();
        return;
      }
      // 'refresh' (es. dopo «Ignora per sempre») ricarica soltanto.
      // Nascondi / Mostra di nuovo: solo il flag, il file resta dov'è.
      if (kind === 'hide' || kind === 'unhide') await setHidden(id, kind === 'hide');
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  const sortedProfiles = useMemo(() => [...profiles].sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })), [profiles]);

  return (
    <>
      <div className="page-head library-head">
        <h1>Libreria</h1>
        <div className="page-actions">
          {view.value === 'da-scaricare' && counts['da-scaricare'] > 0 && !selectMode && (
            <button className="btn" onClick={selectAll} title="Seleziona tutti i video da scaricare, poi «Scarica»">
              <CheckCheck size={14} />Seleziona tutti ({filtered.length})
            </button>
          )}
          <button className={`btn${selectMode ? ' btn-active' : ''}`} onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}>
            <SquareCheck size={14} />{selectMode ? 'Fine' : 'Seleziona'}
          </button>
          <div className="seg" role="group" aria-label="Vista">
            <button className={layout === 'grid' ? 'on' : ''} onClick={() => chooseLayout('grid')} title="Griglia" aria-label="Griglia"><LayoutGrid size={14} /></button>
            <button className={layout === 'row' ? 'on' : ''} onClick={() => chooseLayout('row')} title="Lista" aria-label="Lista"><List size={14} /></button>
          </div>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}

      <div className="chips">
        {visibleViews(showHidden).map((o) => (
          <div
            key={o.value}
            className={`chip${view.value === o.value ? ' active' : ''}`}
            onClick={() => setParam('vista', o.value === 'tutti' ? null : o.value)}
          >
            {o.star && <Star size={12} fill={view.value === o.value ? 'currentColor' : 'none'} />}
            {o.dot && <span className="dot" style={{ background: statusColor(o.dot) }}></span>}
            {o.label}
            {counts[o.value] > 0 && <span className="count">{counts[o.value]}</span>}
          </div>
        ))}
      </div>

      <div className="filter-bar">
        <select value={sort} onChange={(e) => setParam('ordine', e.target.value === 'uploadDate' ? null : e.target.value)} aria-label="Ordina per">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className={creator ? 'discreet-text' : undefined} value={creator} onChange={(e) => setParam('creator', e.target.value)} aria-label="Filtra per creator">
          <option value="">Tutti i creator</option>
          {sortedProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className={source && source !== SINGLE ? 'discreet-text' : undefined} value={source} onChange={(e) => setParam('fonte', e.target.value)} aria-label="Filtra per fonte">
          <option value="">Tutte le fonti</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value={SINGLE}>Singoli (senza fonte)</option>
        </select>
      </div>

      {(view.value === 'salvati' || view.value === 'persi') && filtered.length > 0 && (
        <div className="banner">
          <Archive size={18} />
          <div className="banner-text">
            <b>{view.value === 'salvati' ? 'Su YouTube non ci sono più, ma li hai salvati in tempo' : 'Spariti da YouTube prima che li scaricassi'}</b>
            <span>{view.value === 'salvati' ? 'Il file è nella tua libreria: è l\'unica copia rimasta.' : 'Non si possono più scaricare: di questi resta solo la scheda con i metadati.'}</span>
          </div>
        </div>
      )}

      {videos === null ? (
        layout === 'row' ? <SkeletonRows className="row-list" /> : <SkeletonGrid />
      ) : view.value === 'problemi' && !selectMode && filtered.length > 0 ? (
        <ProblemGroups videos={filtered} onChanged={reload} />
      ) : filtered.length === 0 ? (
        <div className="empty-state">Nessun video in questa vista.</div>
      ) : (
        <>
        <div className={layout === 'row' ? 'row-list' : 'grid'}>
          {page.visible.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              layout={layout}
              onDecide={handleAction}
              selectMode={selectMode}
              selected={selected.has(v.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
        {page.hasMore && <div ref={page.sentinelRef} className="list-more" aria-hidden="true"><span className="spinner" /></div>}
        </>
      )}

      {selectMode && (
        <div className="bulk-bar" role="toolbar" aria-label="Azioni sui selezionati">
          <span className="bulk-count">{selected.size} selezionat{selected.size === 1 ? 'o' : 'i'}</span>
          <button className="btn small" onClick={allSelected ? () => setSelected(new Set()) : selectAll}>
            <CheckCheck size={14} />{allSelected ? 'Deseleziona tutti' : `Seleziona tutti (${filtered.length})`}
          </button>
          <span className="bulk-sep" />
          {/* Lo scaricamento di gruppo solo in "Da scaricare": lì la selezione
              contiene per definizione solo video da scaricare. */}
          {view.value === 'da-scaricare' && (
            <button className="btn small btn-primary" disabled={busy || downloadable.length === 0} onClick={bulkDownload}>
              <CloudDownload size={14} />Scarica{downloadable.length ? ` ${downloadable.length}` : ''}
            </button>
          )}
          <button className="btn small" disabled={busy || selected.size === 0} onClick={bulkMetadata}>
            <FileDown size={14} />Aggiorna metadati…
          </button>
          <button className="btn small" disabled={busy || queueable.length === 0} onClick={bulkQueue} title="Solo i video scaricati">
            <ListPlus size={14} />Aggiungi alla coda
          </button>
          {view.value === 'nascosti' ? (
            <button className="btn small" disabled={busy || selected.size === 0} onClick={() => bulkHide(false)}>
              <Eye size={14} />Mostra di nuovo
            </button>
          ) : (
            <button className="btn small" disabled={busy || selected.size === 0} onClick={() => bulkHide(true)}>
              <EyeOff size={14} />Nascondi
            </button>
          )}
          <button className="bulk-close" onClick={exitSelect} aria-label="Chiudi selezione" title="Chiudi (Esc)"><X size={16} /></button>
        </div>
      )}
    </>
  );
}
