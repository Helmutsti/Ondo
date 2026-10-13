import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreVertical, Download, CloudDownload, RotateCw, EyeOff, Eye, User, FileDown, Star, StarOff, Trash2, ListPlus, ListMinus, AlertTriangle, Ban, Lock, Check } from 'lucide-react';
import { coverState, leftAllSources } from '../lib/libraryFilters.js';
import { formatDuration, videoDisplayDate, channelKey, channelInitial } from '../lib/format.js';
import { actionsFor } from '../lib/reviewActions.js';
import { confirmDialog } from '../lib/dialog.js';
import { useActiveDownloadJobId } from '../lib/downloadTracker.js';
import { useVideoActivity } from '../lib/activityStore.js';
import { openMetadataWizard } from '../lib/metadataWizard.js';
import { useJobStream } from '../hooks/useJobStream.js';
import { addToQueue, removeFromQueue, useQueue } from '../lib/queueStore.js';
import { showToast } from '../lib/toast.js';

// Voci del menu ⋮ per tipo di azione (kind da actionsFor). Etichette/icone in
// stile YouTube; "hide"→Nascondi, "unhide"→Mostra di nuovo. Nascondere non è
// distruttivo: niente più rosso (redesign R1).
const MENU = {
  download: { label: 'Scarica video', Icon: Download },
  hide: { label: 'Nascondi', Icon: EyeOff },
  unhide: { label: 'Mostra di nuovo', Icon: Eye }
};

// Pillola di stato sulla copertina (card v2): icona per tipo.
const PILL_ICON = { available: CloudDownload, downloading: Download, failed: AlertTriangle, saved: AlertTriangle, lost: Ban, restricted: Lock };

// `layout`: 'grid' (default, invariato) per Home/Archiviati/creator; 'row' per
// la card orizzontale (M53) usata in Cerca e "Video suggeriti" — stesso
// componente, stessa logica di stato/menu ⋮, solo la struttura JSX cambia,
// così le due varianti non possono divergere (è la divergenza ad aver causato
// il bug delle card profilo).
// selectMode: la card si seleziona al click invece di aprire il video;
// onToggleSelect(id, event) riceve l'evento per lo Shift+click a intervalli.
export function VideoCard({ video, onDecide, selected, onToggleSelect, selectMode = false, layout = 'grid' }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const kebabRef = useRef(null);
  const menuListRef = useRef(null);
  const dur = formatDuration(video.durationSeconds);
  const date = videoDisplayDate(video);
  const actions = actionsFor(video);
  // Il job del download secondo il server (vedi sotto): se sta girando la card
  // è "in download" anche se l'elenco dei video non è stato ancora ricaricato.
  const serverJob = useVideoActivity(video.id);
  const downloading = video.download === 'downloading' || serverJob?.status === 'running';
  // jobId noto solo se il download è stato avviato da questa stessa sessione
  // (vedi lib/downloadTracker.js): se assente (pagina ricaricata a metà
  // download, o avviato altrove) niente percentuale reale, il cerchio ricade
  // su un'animazione indeterminata.
  // Il job del download: quello avviato da questa scheda (stream dal vivo),
  // altrimenti quello che riporta l'Attività del server — così il progresso
  // c'è anche dopo un ricaricamento o per un download avviato altrove.
  const trackedJobId = useActiveDownloadJobId(video.id);
  const activeJobId = trackedJobId ?? (serverJob?.status === 'running' ? serverJob.jobId : null);
  const live = useJobStream(downloading ? activeJobId : null);
  const progress = live.progress ?? (downloading ? serverJob?.progress ?? null : null);
  const queuePosition = serverJob?.status === 'queued' ? serverJob.queuePosition : null;
  // Archivia/Ripristina va in fondo al menu, separato dalle altre azioni.
  const archiveAction = actions.find((a) => a.kind === 'hide' || a.kind === 'unhide');
  const otherActions = actions.filter((a) => a.kind !== 'hide' && a.kind !== 'unhide');
  const key = channelKey(video);
  // Il profilo creator del video (arriva dal server); i vecchi link per canale
  // restano come ripiego e reindirizzano comunque al profilo.
  const creatorPath = video.channel?.profileId
    ? `/creators/${encodeURIComponent(video.channel.profileId)}`
    : key ? `/channels/${encodeURIComponent(key)}` : null;
  // Coda di riproduzione effimera (M52): solo sui video scaricati (senza file
  // locale non c'è nulla da autoplayare quando gli tocca il turno) — stesso
  // vincolo del CLI, che offre "Aggiungi alla coda" solo tra i già scaricati.
  const isDownloaded = video.download === 'downloaded';
  const queueItems = useQueue();
  const queued = queueItems.some((q) => q.id === video.id);

  // Bug: su una card in fondo al viewport il menu ⋮ (aperto sempre verso il
  // basso) usciva fuori schermo e le voci restavano irraggiungibili. All'apertura
  // misuriamo lo spazio sotto il kebab: se non basta per il menu e sopra c'è
  // posto, lo apriamo verso l'alto. useLayoutEffect così il flip avviene prima
  // del paint (nessun lampeggio verso il basso).
  useLayoutEffect(() => {
    if (!menuOpen) { setDropUp(false); return; }
    const btn = kebabRef.current;
    const list = menuListRef.current;
    if (!btn || !list) return;
    const r = btn.getBoundingClientRect();
    const h = list.offsetHeight;
    setDropUp(window.innerHeight - r.bottom < h + 8 && r.top > h + 8);
  }, [menuOpen]);

  async function act(kind) {
    setMenuOpen(false);
    if (kind === 'queue') {
      addToQueue(video);
      showToast('Aggiunto alla coda.', 'success', 2000);
      return;
    }
    if (kind === 'metadata') {
      openMetadataWizard({ label: video.title ?? video.id, videos: [video], allLabel: 'Questo video' });
      return;
    }
    if (kind === 'unqueue') {
      removeFromQueue(video.id);
      showToast('Rimosso dalla coda.', 'info', 2000);
      return;
    }
    if (kind === 'deletevideo') {
      // Cancellazione totale e irreversibile (punto 11): conferma esplicita,
      // stesso modale usato per gli altri confirm dell'app.
      const ok = await confirmDialog({
        title: 'Cancellare definitivamente il video?',
        message: `Azione irreversibile: file, copertina e scheda di "${video.title ?? video.id}" verranno cancellati per sempre. Se il video appartiene ancora a una fonte, la prossima sincronizzazione potrebbe reinserirlo in libreria.`,
        confirmLabel: 'Cancella per sempre',
        danger: true
      });
      if (!ok) return;
    }
    onDecide(video.id, kind);
  }

  const pill = coverState(downloading ? { ...video, download: 'downloading' } : video, { progress, queuePosition });
  const PillIcon = pill ? PILL_ICON[pill.kind] : null;
  // Azione principale sulla copertina (card v2): niente più "apri il menu ⋮
  // per scaricare". Non sui persi (non c'è più niente da scaricare) né sui
  // nascosti, né mentre si seleziona.
  const coverAction = selectMode || video.hidden || downloading || queuePosition != null ? null
    : video.download === 'failed' ? { label: 'Riprova', Icon: RotateCw, cls: 'retry' }
    : video.download === 'none' && video.presence === 'present' ? { label: 'Scarica', Icon: CloudDownload, cls: '' }
    : null;
  const thumbCls = `thumb${layout === 'row' ? ' thumb-row' : ''}${downloading ? ' downloading' : ''}${pill?.kind === 'lost' ? ' lost' : ''}`;

  function handleSelectClick(e) {
    if (!selectMode) return;
    e.preventDefault();
    onToggleSelect?.(video.id, e);
  }

  // Contenuto della copertina: identico in grid e row, cambia solo la classe
  // che ne fissa la dimensione (thumb-row vs il default a piena colonna).
  const thumbInner = (
    <>
      {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : null}
      {(selectMode || selected) && (
        <span className={`card-check${selected ? ' on' : ''}`} aria-hidden="true">{selected && <Check size={13} strokeWidth={3} />}</span>
      )}
      {pill && (
        <span className={`cover-pill ${pill.kind}${selectMode || selected ? ' shifted' : ''}`}>
          <PillIcon size={12} />{pill.label}
        </span>
      )}
      {video.favorite && (
        <div className="fav-star" title="Preferito">
          <Star size={16} fill="currentColor" />
        </div>
      )}
      {downloading && (
        <div className={`cover-progress${progress == null ? ' indeterminate' : ''}`}>
          <div style={progress != null ? { width: `${progress}%` } : undefined}></div>
        </div>
      )}
      {dur && <div className="dur">{dur}</div>}
    </>
  );

  const thumb = (
    <div className="thumb-wrap">
      <Link to={`/videos/${video.id}`} className={thumbCls} onClick={handleSelectClick}>
        {thumbInner}
      </Link>
      {coverAction && (
        <button
          type="button"
          className={`cover-action ${coverAction.cls}`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); act('download'); }}
        >
          <coverAction.Icon size={13} />{coverAction.label}
        </button>
      )}
      {onToggleSelect && !selectMode && !selected && (
        <button
          type="button"
          className="card-check hover-only"
          title="Seleziona il video"
          aria-label="Seleziona il video"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleSelect(video.id, e); }}
        />
      )}
    </div>
  );

  // Il video non è più in nessuna fonte (le playlist non lo elencano più).
  const leftNote = leftAllSources(video) && video.download !== 'downloaded' ? ' · fuori dalle fonti' : '';

  // Menu ⋮: unico in tutta l'app, condiviso da grid e row — è proprio questa
  // condivisione a garantire che le azioni disponibili non divergano mai tra
  // i due layout.
  const menu = (
    <div className="card-menu">
      <button
        ref={kebabRef}
        className="kebab"
        aria-label="Azioni"
        title="Azioni"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen((o) => !o); }}
      >
        <MoreVertical size={16} />
      </button>
      {menuOpen && (
        <>
          <div className="menu-backdrop" onClick={(e) => { e.preventDefault(); setMenuOpen(false); }}></div>
          <div ref={menuListRef} className={`menu-list${dropUp ? ' up' : ''}`} onClick={(e) => e.stopPropagation()}>
            {otherActions.map((a) => {
              const m = MENU[a.kind] ?? MENU.download;
              const Icon = m.Icon;
              return (
                <button key={a.kind} className="menu-item" onClick={() => act(a.kind)}>
                  <Icon size={15} />{m.label}
                </button>
              );
            })}
            {/* Preferito (M43): toggle indipendente, ammesso in qualunque stato */}
            <button className="menu-item" onClick={() => act(video.favorite ? 'unfavorite' : 'favorite')}>
              {video.favorite ? <StarOff size={15} /> : <Star size={15} />}
              {video.favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
            </button>
            {/* Coda di riproduzione effimera (M52): come i preferiti, un
                toggle client-side hardcoded, mai instradato su onDecide
                (nessuna chiamata API, nessuno stato di dominio coinvolto). */}
            {isDownloaded && (
              <button className="menu-item" onClick={() => act(queued ? 'unqueue' : 'queue')}>
                {queued ? <ListMinus size={15} /> : <ListPlus size={15} />}
                {queued ? 'Rimuovi dalla coda' : 'Aggiungi alla coda'}
              </button>
            )}
            {/* Aggiorna metadati: anche sui rimossi (ri-verifica) */}
            <button className="menu-item" onClick={() => act('metadata')}>
              <FileDown size={15} />Aggiorna metadati…
            </button>
            {key && (
              <Link className="menu-item" to={creatorPath} onClick={() => setMenuOpen(false)}>
                <User size={15} />Mostra profilo
              </Link>
            )}
            {/* Nascondi/Mostra di nuovo: in fondo al menu */}
            {archiveAction && (
              <button className="menu-item" onClick={() => act(archiveAction.kind)}>
                {archiveAction.kind === 'hide' ? <EyeOff size={15} /> : <Eye size={15} />}
                {MENU[archiveAction.kind].label}
              </button>
            )}
            {/* Cancella definitivamente (punto 11): solo sui video già
                archiviati — gate a due passi, applicato anche lato core. */}
            {video.hidden && (
              <button className="menu-item danger" onClick={() => act('deletevideo')}>
                <Trash2 size={15} />Cancella
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  if (layout === 'row') {
    // Card orizzontale (M53): stessa copertina/menu della grid, impaginati in
    // riga. Usata sia a piena larghezza (Cerca) sia nella colonna stretta dei
    // suggeriti (~260px) — il ridimensionamento della miniatura è tutto in
    // CSS (.thumb-row), qui la struttura è unica per entrambi i contesti.
    return (
      <div className={`card-row${video.hidden ? ' dimmed' : ''}${selected ? ' selected' : ''}`}>
        {thumb}
        <div className="row-body">
          <Link to={`/videos/${video.id}`} className="row-title discreet-text" onClick={handleSelectClick}>
            {video.title ?? video.id}
          </Link>
          <div className="row-meta discreet-text">
            {video.channel?.name ?? 'Creator sconosciuto'}{date ? ` · ${date}` : ''}{leftNote}
          </div>
        </div>
        {menu}
      </div>
    );
  }

  return (
    <div className={`card${video.hidden ? ' dimmed' : ''}${selected ? ' selected' : ''}${pill?.kind === 'lost' ? ' lost' : ''}`}>
      {thumb}
      <Link to={`/videos/${video.id}`} className="card-title discreet-text" onClick={handleSelectClick}>
        {video.title ?? video.id}
      </Link>
      <div className="card-info">
        {key ? (
          <Link to={creatorPath} className="avatar">
            {video.channel?.avatarUrl ? <img className="avatar-photo" src={video.channel.avatarUrl} alt="" /> : channelInitial(video)}
          </Link>
        ) : (
          <div className="avatar">
            {video.channel?.avatarUrl ? <img className="avatar-photo" src={video.channel.avatarUrl} alt="" /> : channelInitial(video)}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-meta discreet-text">{video.channel?.name ?? 'Creator sconosciuto'}</div>
          {(date || leftNote) && <div className="card-meta">{date}{leftNote}</div>}
        </div>

        {menu}
      </div>
    </div>
  );
}
