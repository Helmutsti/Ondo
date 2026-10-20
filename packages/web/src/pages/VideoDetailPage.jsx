import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { MoreVertical, ExternalLink, CircleSlash, Download, Eye, EyeOff, Maximize2, FileDown, Star, ChevronRight, ChevronLeft, ListMusic, RefreshCw, X, SkipForward } from 'lucide-react';
import { getVideo, listVideos, setHidden, setFavorite, triggerJob, refreshMetadata } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { VideoCard } from '../components/VideoCard.jsx';
import { VideoMetadataPanel, VideoHistoryPanel } from '../components/VideoMetadataPanels.jsx';
import { openMetadataWizard } from '../lib/metadataWizard.js';
import { ignoreWithConfirm } from '../lib/ignoreAction.js';
import { useActivity } from '../lib/activityStore.js';
import { actionsFor } from '../lib/reviewActions.js';
import { isLost } from '../lib/libraryFilters.js';
import { useTitle } from '../hooks/useTitle.js';
import { startDownload } from '../lib/downloadActions.js';
import { formatDuration, videoDisplayDate, channelKey, channelInitial, formatBytes, formatBitrate } from '../lib/format.js';
import { showToast, updateToast } from '../lib/toast.js';
import { useQueue, removeFromQueue, clearQueue } from '../lib/queueStore.js';
import { usePlayer, setCurrent, setMinimized, useAutoplayOnOpen } from '../lib/playerStore.js';
import { sized, SMALL, AVATAR } from '../lib/images.js';
import { useQueueAdvance } from '../hooks/useQueueAdvance.js';

const DOWNLOAD_LABEL = { none: 'Non scaricato', downloading: 'In download', downloaded: 'Scaricato', failed: 'Errore download' };

export function VideoDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const [video, setVideo] = useState(null);
  const [tab, setTab] = useState('desc');
  const [related, setRelated] = useState([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedCollapsed, setRelatedCollapsed] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const navigate = useNavigate();
  const [descExpanded, setDescExpanded] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  const descRef = useRef(null);
  const queue = useQueue();
  // Player globale (M54): il <video> non vive più qui ma in MiniPlayer, sopra il
  // router. `player.current` dice quale video il player globale sta mostrando
  // (usato come dipendenza degli effetti che agiscono sull'elemento reale, che
  // esiste solo dopo che il player si è agganciato allo slot di questa pagina).
  const player = usePlayer();
  const autoplayOnOpen = useAutoplayOnOpen();
  // Avanzamento coda condiviso con MiniPlayer (M57): stesso percorso della fine
  // video, così i pulsanti "Successivo" e l'autoplay non divergono.
  const goToNext = useQueueAdvance();
  // Autoplay in coda (M52): evita di richiedere il play più di una volta per
  // ogni navigazione — l'effetto qui sotto ha video?.videoUrl tra le
  // dipendenze e ri-scatterebbe altrimenti a ogni suo re-render.
  const autoplayedRef = useRef(false);

  function reload() {
    setError(null);
    getVideo(id).then(setVideo).catch((e) => setError(e.message));
  }

  // Un lavoro appena finito (metadati dal wizard, download) cambia la scheda.
  const lastFinished = useActivity()?.finished?.[0]?.id;
  useEffect(() => { if (lastFinished && video) reload(); }, [lastFinished]);

  useEffect(reload, [id]);
  useEffect(() => { autoplayedRef.current = false; }, [id]);
  useEffect(() => setDescExpanded(false), [id]);

  // Descrizione collassabile in stile YouTube: il toggle "Mostra altro" deve
  // comparire solo se il testo eccede davvero le righe clampate — una soglia
  // sui caratteri sarebbe approssimativa (dipende da font/larghezza colonna),
  // mentre confrontare scrollHeight/clientHeight sul nodo reale è esatto.
  // useLayoutEffect (non useEffect) per misurare prima del paint ed evitare
  // un flash del pulsante con lo stato della descrizione precedente quando
  // si cambia video. La misura è valida quando descExpanded è false (clamp
  // CSS attivo): è il caso che si verifica sempre al cambio di id, perché
  // l'effetto sopra riporta descExpanded a false in coppia.
  useLayoutEffect(() => {
    const el = descRef.current;
    setDescClamped(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [video?.description, video?.id, tab]);

  // Aggancio al player globale (M54): quando questo video è scaricabile,
  // diventa il "corrente" del player globale, che si aggancia allo slot qui
  // sotto (#player-dock-slot). `play: true` quando si arriva da un autoplay di
  // coda (navigate con state.autoplay a fine video, M52) — il player globale
  // avvia la riproduzione appena l'elemento è pronto. Da M60 l'autoplay parte
  // anche alla semplice apertura manuale della pagina, se la preferenza client
  // `autoplayOnOpen` è attiva (default ON); l'avanzamento della coda resta
  // indipendente da questa preferenza. Best-effort: alcuni browser possono
  // bloccare l'autoplay con audio; in quel caso resta la copertina "Riproduci".
  useEffect(() => {
    if (video?.download !== 'downloaded' || !video.videoUrl) return;
    const wantPlay = (autoplayOnOpen || !!location.state?.autoplay) && !autoplayedRef.current;
    if (wantPlay) autoplayedRef.current = true;
    setCurrent(video, { play: wantPlay });
    // `!player.current`: se il player globale viene chiuso mentre si è qui,
    // la pagina se lo riprende (senza autoplay), invece di restare vuota.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id, video?.videoUrl, location.state, !player.current]);

  // Velocità, Picture in Picture, minimizza e schermo intero stanno nei
  // comandi sopra il video (components/PlayerControls.jsx).

  // "Video suggeriti" (punto 1 del backlog): selezione casuale su tutta la
  // libreria (non più limitata allo stesso canale), esclusi il video corrente,
  // gli archiviati e quelli spariti da YouTube senza un file (i «Persi»: non
  // si possono più guardare; i «Salvati» invece sì, e restano).
  // Estratta in una funzione così il pulsante "rimescola" può
  // ripescarne 5 nuovi su richiesta, ri-scaricando la lista dal server (vede
  // eventuali video aggiunti/rimossi/archiviati nel frattempo).
  const loadRelated = useCallback(() => {
    if (!video) return;
    setRelatedLoading(true);
    listVideos()
      .then((videos) => {
        const pool = videos.filter((v) => v.id !== video.id && !v.hidden && !isLost(v));
        const shuffled = [...pool].sort(() => Math.random() - 0.5);
        setRelated(shuffled.slice(0, 5));
      })
      .catch(() => setRelated([]))
      .finally(() => setRelatedLoading(false));
    // Solo l'id: stellina, metadati o un lavoro finito ricaricano `video` (nuovo
    // oggetto, stesso video) e non devono rimescolare i suggeriti.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id]);

  // Ricalcolo automatico solo quando si passa a un altro video.
  useEffect(() => { loadRelated(); }, [loadRelated]);

  async function handleAction(kind, label) {
    try {
      if (kind === 'download') {
        await startDownload(id, { triggerJob, onSettled: reload, title: video.title });
        return;
      }
      if (kind === 'hide') {
        await setHidden(id, true);
        reload();
        return;
      }
      if (kind === 'metadata') {
        const toastId = showToast('Aggiornamento metadati avviato…', 'info', 0);
        try {
          await refreshMetadata(id);
          setNotice('Metadati aggiornati.');
          updateToast(toastId, { message: 'Metadati aggiornati.', type: 'success' });
          reload();
        } catch (e) {
          updateToast(toastId, { message: `Aggiornamento metadati fallito: ${e.message}`, type: 'error' });
          throw e;
        }
        return;
      }
      await setHidden(id, false); // unhide
      setNotice(`${label}: fatto.`);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  // Menu ⋮ della card orizzontale di un suggerito (M53): stesso ventaglio di
  // azioni di handleAction, ma sul suggerito cliccato, non sul video in
  // pagina. La card si aggiorna sul posto, senza rimescolare gli altri
  // suggeriti; un video nascosto sparisce dalla lista.
  function refreshRelated(rid) {
    return getVideo(rid)
      .then((fresh) => setRelated((list) => list.map((r) => (r.id === rid ? fresh : r))))
      .catch(() => {});
  }

  async function handleRelatedAction(rid, kind) {
    const target = related.find((r) => r.id === rid);
    try {
      if (kind === 'download') {
        await startDownload(rid, { triggerJob, onSettled: () => refreshRelated(rid), title: target?.title });
        return;
      }
      if (kind === 'metadata') {
        await refreshMetadata(rid);
        await refreshRelated(rid);
        return;
      }
      if (kind === 'favorite' || kind === 'unfavorite') {
        await setFavorite(rid, kind === 'favorite');
        await refreshRelated(rid);
        return;
      }
      // 'refresh' arriva dopo «Ignora per sempre»: il video non esiste più.
      if (kind === 'refresh') {
        setRelated((list) => list.filter((r) => r.id !== rid));
        return;
      }
      if (kind === 'hide') {
        await setHidden(rid, true);
        setRelated((list) => list.filter((r) => r.id !== rid));
        return;
      }
      if (kind === 'unhide') await setHidden(rid, false);
      await refreshRelated(rid);
    } catch (e) {
      setError(e.message);
    }
  }

  // «Ignora per sempre»: dopo, la scheda non esiste più → si torna indietro.
  async function handleIgnore() {
    if (await ignoreWithConfirm(video)) {
      if (window.history.length > 1) navigate(-1); else navigate('/');
    }
  }

  // Nascondi: toglie il video dalla libreria e basta (il file resta).
  function handleArchive() {
    handleAction('hide');
  }

  // Preferito (M43 era limitato al menu ⋮ di VideoCard): estensione al
  // dettaglio video, indipendente dallo stato di download come ogni altro
  // uso del flag `favorite`.
  async function toggleFavorite() {
    try {
      setVideo(await setFavorite(id, !video.favorite));
    } catch (e) {
      setError(e.message);
    }
  }

  useTitle(video?.title ?? null);

  if (error) {
    return (
      <div className="notice error">{error}</div>
    );
  }
  if (!video) return <div className="empty-state"><span className="spinner"></span></div>;

  const key = channelKey(video);
  const channelHref = key
    ? (video.channel?.profileId ? `/creators/${encodeURIComponent(video.channel.profileId)}` : `/channels/${encodeURIComponent(key)}`)
    : null;
  const actions = actionsFor(video);
  const isDownloaded = video.download === 'downloaded';
  // Esiste un "successivo" reale in coda? (M57, ridefinito in M62 con
  // l'avanzamento non distruttivo). Con getNextAfter il successivo è l'elemento
  // DOPO il video corrente nella coda: se il corrente è in coda ed è l'ultimo
  // non c'è successivo; se non è in coda, il successivo è il primo elemento.
  // Indipendente da isDownloaded: far avanzare la coda non dipende dal file
  // locale del video corrente.
  const currentQueueIdx = queue.findIndex((q) => q.id === id);
  const hasNext = currentQueueIdx === -1 ? queue.length > 0 : currentQueueIdx < queue.length - 1;
  const downloadAction = actions.find((a) => a.kind === 'download');
  const hideAction = actions.find((a) => a.kind === 'hide' || a.kind === 'unhide');
  const dur = formatDuration(video.durationSeconds);
  const date = videoDisplayDate(video);

  // sha256 escluso deliberatamente (poco interessante da leggere per un
  // utente finale) — resta comunque nel catalogo/API se mai servisse altrove.
  const techFields = [
    {
      label: 'Risoluzione',
      value: video.resolution?.width && video.resolution?.height
        ? `${video.resolution.width}×${video.resolution.height}${video.resolution.fps ? ` · ${video.resolution.fps}fps` : ''}`
        : null
    },
    { label: 'Codec video', value: video.video?.videoCodec },
    { label: 'Codec audio', value: video.video?.audioCodec },
    { label: 'Bitrate', value: formatBitrate(video.video?.bitrateKbps) },
    { label: 'Dimensione file', value: formatBytes(video.video?.sizeBytes) },
    { label: 'Formato', value: video.video?.container },
    { label: 'yt-dlp', value: video.video?.ytdlpVersion }
  ].filter((f) => f.value);

  return (
    <>
      <div className="detail-body">
        <div className="player-col">
          <div className="player-frame">
            {isDownloaded && video.videoUrl ? (
              (player.minimized && player.current?.id === video.id) ? (
                /* "Minimizza" attivo su questo video: il player è nel riquadro
                   flottante, la cornice resta qui con un invito a riportarlo. */
                <div className="player-placeholder">
                  <span>In riproduzione nel mini-player.</span>
                  <button className="btn" onClick={() => setMinimized(false)}>
                    <Maximize2 size={14} />Riporta qui
                  </button>
                </div>
              ) : (
                /* Slot di aggancio del player globale (M54): il vero <video> vive
                   in MiniPlayer (sopra il router) e viene spostato qui dentro
                   quando si è su questa pagina, così cambiando route non si taglia
                   la riproduzione. La copertina "clicca per riprodurre" è resa dal
                   player globale stesso quando agganciato e non ancora avviato. */
                <div id="player-dock-slot" className="player-dock-slot" />
              )
            ) : video.download === 'downloading' ? (
              <div className="player-placeholder">
                <span className="spinner"></span>
                <span>Download in corso — vedi il progresso in <Link to="/sources">Sorgenti</Link>.</span>
              </div>
            ) : (
              <div
                className="player-placeholder discreet-bg"
                style={video.thumbnailUrl ? {
                  backgroundImage: `linear-gradient(rgba(8,8,10,.82), rgba(8,8,10,.82)), url("${video.thumbnailUrl}")`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                } : undefined}
              >
                <StatusBadge video={video} inline />
                <span>Non ancora disponibile per la riproduzione.</span>
              </div>
            )}
          </div>

          <h1 className="d-title discreet-text">{video.title ?? video.id}</h1>

          <div className="d-row">
            {/* Foto, nome e durata/data sono un unico blocco: tutto porta alla
                pagina del creator (o del canale, se non ha ancora un profilo). */}
            {(() => {
              const content = (
                <>
                  <div className="d-avatar">
                    {video.channel?.avatarUrl ? <img className="avatar-photo" src={sized(video.channel.avatarUrl, AVATAR)} alt="" /> : channelInitial(video)}
                  </div>
                  <div>
                    <div className="d-chan-name discreet-text">{video.channel?.name ?? 'Creator sconosciuto'}</div>
                    <div className="d-meta">{[dur, date].filter(Boolean).join(' · ')}</div>
                  </div>
                </>
              );
              return channelHref
                ? <Link to={channelHref} className="d-chan d-chan-link">{content}</Link>
                : <div className="d-chan">{content}</div>;
            })()}
            <div className="d-actions">
              <button
                className={`icon-btn fav-toggle${video.favorite ? ' active' : ''}`}
                onClick={toggleFavorite}
                title={video.favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
                aria-label={video.favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
              >
                <Star size={18} fill={video.favorite ? 'currentColor' : 'none'} />
              </button>
              {downloadAction && (
                <button className="btn btn-primary" onClick={() => handleAction('download', downloadAction.label)}>
                  <Download size={14} />{downloadAction.label}
                </button>
              )}
              {/* Le azioni rare (redesign R4.5) stanno qui, non in vista. */}
              <span className="chip-menu-wrap">
                <button className="icon-btn" aria-label="Altre azioni" title="Altre azioni" onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o); }}>
                  <MoreVertical size={16} />
                </button>
                {moreOpen && (
                  <>
                    <div className="menu-backdrop" onClick={() => setMoreOpen(false)}></div>
                    <div className="menu-list detail-menu" onClick={() => setMoreOpen(false)}>
                      {isDownloaded && (
                        <button className="menu-item" onClick={() => handleAction('download')}><RefreshCw size={15} />Riscarica…</button>
                      )}
                      <button className="menu-item" onClick={() => openMetadataWizard({ label: video.title ?? video.id, videos: [video], allLabel: 'Questo video' })}><FileDown size={15} />Aggiorna metadati…</button>
                      {hideAction?.kind === 'hide' && <button className="menu-item" onClick={handleArchive}><EyeOff size={15} />Nascondi</button>}
                      {hideAction?.kind === 'unhide' && <button className="menu-item" onClick={() => handleAction('unhide', 'Ripristinato')}><Eye size={15} />Mostra di nuovo</button>}
                      {video.webpageUrl && <a className="menu-item" href={video.webpageUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Apri su YouTube</a>}
                      <button className="menu-item danger" onClick={handleIgnore}><CircleSlash size={15} />Ignora per sempre…</button>
                    </div>
                  </>
                )}
              </span>
            </div>
          </div>


          {notice && <div className="notice success" style={{ marginTop: 16 }}>{notice}</div>}

          {/* Nota "qualità ridotta" (M55): compare quando il video è stato
              scaricato a una risoluzione più bassa di quella disponibile (es.
              perché al momento del download mancava un formato migliore). Avviso
              non invadente che invita a ri-scaricare per riprovare l'alta qualità. */}
          {video.video?.qualityNote && (
            <div className="notice" style={{ marginTop: 16 }}>
              Qualità ridotta: scaricato a {video.video.qualityNote.downloadedHeight}p
              {video.video.qualityNote.maxAvailableHeight
                ? ` (disponibili fino a ${video.video.qualityNote.maxAvailableHeight}p).`
                : '. YouTube potrebbe limitare temporaneamente la qualità.'}
              {' '}Usa "Riscarica" per riprovare l'alta qualità più tardi.
            </div>
          )}

          {video.download === 'failed' && video.error && (
            <div className="notice error" style={{ marginTop: 16 }}>
              Download fallito ({video.attempts} tentativ{video.attempts === 1 ? 'o' : 'i'}): {typeof video.error === 'string'
                ? video.error
                : [video.error?.hint, video.error?.message].filter(Boolean).join(' — ') || 'errore sconosciuto'}
            </div>
          )}

          {/* Schede (redesign R4.5): Descrizione · Metadati · Cronologia · File e qualità. */}
          <div className="d-tabs" role="tablist">
            {[['desc', 'Descrizione'], ['meta', 'Metadati'], ['history', `Cronologia${video.metadataHistory?.length ? ` · ${video.metadataHistory.length}` : ''}`], ['file', 'File e qualità']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>

          {tab === 'desc' && (
            <>
              {(video.description || video.tags?.length > 0) && (
                <div className="d-desc">
                  {video.description && (
                    <>
                      <span className="label">Descrizione</span>
                      <div ref={descRef} className={`d-desc-text discreet-text${descExpanded ? ' expanded' : ''}`}>
                        {video.description}
                      </div>
                      {descClamped && (
                        <button
                          type="button"
                          className="d-desc-toggle"
                          onClick={() => setDescExpanded((v) => !v)}
                          aria-expanded={descExpanded}
                        >
                          {descExpanded ? 'Mostra meno' : 'Mostra altro'}
                        </button>
                      )}
                    </>
                  )}
                  {/* I tag restano sempre visibili (non nella parte collassabile):
                      sono chip brevi già pensati per una scansione rapida, non
                      prosa da troncare come la descrizione — nasconderli dietro
                      "Mostra altro" li renderebbe meno utili senza risparmiare
                      spazio in modo apprezzabile. */}
                  {video.tags?.length > 0 && (
                    <div className="d-tags">
                      {video.tags.slice(0, 12).map((tag) => <div key={tag} className="d-tag discreet-text">{tag}</div>)}
                    </div>
                  )}
                </div>
              )}

              {!video.description && !video.tags?.length && <div className="empty-state">Nessuna descrizione.</div>}
            </>
          )}
          {tab === 'meta' && <VideoMetadataPanel video={video} onChange={setVideo} />}
          {tab === 'history' && <VideoHistoryPanel video={video} onChange={setVideo} />}
          {tab === 'file' && (
            <>
          {techFields.length > 0 && (
            <div className="d-desc">
              <span className="label">Dati tecnici</span>
              <div className="tech-grid">
                {techFields.map((f) => (
                  <div key={f.label}>
                    <span className="tech-key">{f.label}</span>
                    <span className="tech-val">{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Box stato e sincronizzazione del singolo video (M35) */}
          <div className="d-desc">
            <span className="label">Stato e sincronizzazione</span>
            <div className="tech-grid">
              <div>
                <span className="tech-key">Presenza</span>
                <span className="tech-val">
                  {/* Etichetta site-agnostica (backlog #2): un video può venire
                      da YouTube, Rumble, ecc. — "Originale" invece di "YouTube". */}
                  {video.presence === 'removed'
                    ? `Originale rimosso${video.removedAt ? ` · ${new Date(video.removedAt).toLocaleDateString('it-IT')}` : ''}`
                    : <a href={video.webpageUrl} target="_blank" rel="noopener noreferrer">Originale presente</a>}
                </span>
              </div>
              <div>
                <span className="tech-key">Download</span>
                <span className="tech-val">{DOWNLOAD_LABEL[video.download] ?? video.download}</span>
              </div>
              <div>
                <span className="tech-key">Nascosto</span>
                <span className="tech-val">{video.hidden ? 'Sì' : 'No'}</span>
              </div>
              <div>
                <span className="tech-key">Metadati aggiornati</span>
                <span className="tech-val">{video.enrichedAt ? new Date(video.enrichedAt).toLocaleString('it-IT') : '—'}</span>
              </div>
              <div>
                <span className="tech-key">Sorgente</span>
                <span className="tech-val">
                  {video.sources?.length
                    ? video.sources.map((s) => s.name ?? s.sourceId).join(', ')
                    : 'Video singolo'}
                </span>
              </div>
            </div>
          </div>
            </>
          )}
        </div>

        {(queue.length > 0 || related.length > 0) && (
          <div className={`side-related${relatedCollapsed ? ' collapsed' : ''}`}>
            {relatedCollapsed ? (
              /* Collassata (M49, ridisegnato): scompare tutto — coda, header e
                 suggeriti — e resta solo una freccia "‹" per riaprire, ancorata
                 in alto; il player si prende lo spazio liberato. */
              <button
                className="rel-collapse-btn rel-reopen-btn"
                onClick={() => setRelatedCollapsed(false)}
                title="Espandi i suggeriti"
                aria-label="Espandi i suggeriti"
              >
                <ChevronLeft size={18} />
              </button>
            ) : (
              <>
                {/* Coda di riproduzione effimera (M52): box evidenziato, sopra
                    "Video suggeriti", mostrato solo a coda non vuota. */}
                {queue.length > 0 && (
                  <div className="queue-box">
                    <div className="rel-header">
                      <div className="rel-lbl"><ListMusic size={13} /> In coda ({queue.length})</div>
                      <div className="rel-actions">
                        {/* "Successivo" (M57): seconda affordance dello stesso salto,
                            accanto alla X "svuota coda". */}
                        {hasNext && (
                          <button className="rel-collapse-btn" onClick={() => goToNext({ currentId: id })} title="Vai al prossimo video" aria-label="Vai al prossimo video">
                            <SkipForward size={14} />
                          </button>
                        )}
                        <button className="rel-collapse-btn" onClick={clearQueue} title="Svuota coda" aria-label="Svuota coda">
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="queue-list">
                      {queue.map((q) => (
                        <div key={q.id} className={`rel-item queue-item${q.id === id ? ' queue-item-current' : ''}`}>
                          <Link to={`/videos/${q.id}`} className="rel-thumb">
                            {q.thumbnailUrl && <img src={sized(q.thumbnailUrl, SMALL)} alt="" loading="lazy" />}
                            {formatDuration(q.durationSeconds) && <div className="dur">{formatDuration(q.durationSeconds)}</div>}
                          </Link>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Link to={`/videos/${q.id}`} className="rel-title discreet-text">{q.title}</Link>
                            {q.channelName && <div className="rel-meta discreet-text">{q.channelName}</div>}
                          </div>
                          <button
                            className="rel-collapse-btn"
                            onClick={() => removeFromQueue(q.id)}
                            title="Rimuovi dalla coda"
                            aria-label="Rimuovi dalla coda"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {related.length > 0 && (
                  <>
                    <div className="rel-header">
                      <div className="rel-lbl">Video suggeriti</div>
                      <div className="rel-actions">
                        <button
                          className="rel-collapse-btn"
                          onClick={loadRelated}
                          disabled={relatedLoading}
                          title="Rimescola i suggeriti"
                          aria-label="Rimescola i suggeriti"
                        >
                          <RefreshCw size={15} className={relatedLoading ? 'spin' : undefined} />
                        </button>
                        <button
                          className="rel-collapse-btn"
                          onClick={() => setRelatedCollapsed(true)}
                          title="Comprimi i suggeriti"
                          aria-label="Comprimi i suggeriti"
                        >
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    </div>
                    {related.map((r) => (
                      <VideoCard key={r.id} video={r} layout="row" onDecide={handleRelatedAction} />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
