import { useEffect, useRef, useState } from 'react';
import {
  Play, Pause, Volume2, VolumeX, Settings, PictureInPicture2, Minimize2, Maximize, Minimize,
  RotateCcw, RotateCw, ChevronLeft, ChevronRight, Check, Gauge, Layers
} from 'lucide-react';
import { formatDuration } from '../lib/format.js';
import { setMinimized, useMiniPlayerEnabled } from '../lib/playerStore.js';

// Velocità in ordine crescente (erano nel menu a tendina sotto il video).
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
const HIDE_AFTER_MS = 2500;
const SKIP_SECONDS = 10;
const DOUBLE_TAP_MS = 300;

const time = (t) => formatDuration(Number.isFinite(t) ? Math.floor(t) : 0);

function qualityLabel(q, info, videoHeight) {
  if (q === 'auto') return videoHeight ? `Auto · ${videoHeight}p` : 'Auto';
  if (q === 'original') return info?.height ? `Originale · ${info.height}p` : 'Originale';
  if (q === 'audio') return 'Solo audio';
  return q;
}

function isTyping(el) {
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function fullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

// Comandi sopra il video, al posto di quelli nativi: play, barra, tempo,
// volume, un ingranaggio con velocità e qualità (anche "solo audio"), PiP,
// mini-player e schermo intero. Spariscono durante la riproduzione dopo un
// attimo di inattività, restano in pausa.
//
// Tocco: un tocco mostra/nasconde, doppio tocco a sinistra/destra ±10 s.
// Mouse: clic play/pausa, doppio clic schermo intero.
// Tastiera (solo sulla pagina del video): spazio/K, J/L ±10 s, ←/→ ±5 s, F, M.
//
// `compact`: il riquadro flottante, solo play, barra e tempo.
// Il menu delle impostazioni NON sta dentro .pc: su telefono è un pannello
// fisso dal basso, e dentro un contenitore con z-index finirebbe sotto la
// barra di navigazione. Lo rende MiniPlayer accanto (vedi `settings`).
export function PlayerControls({ video, container, compact, quality, settingsOpen, setSettingsOpen }) {
  const miniEnabled = useMiniPlayerEnabled();
  const [, force] = useState(0);
  const [visible, setVisible] = useState(true);
  const [scrub, setScrub] = useState(null); // frazione 0..1 mentre si trascina
  const [isPiP, setIsPiP] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [flash, setFlash] = useState(null); // { side, key } per il ±10 s del doppio tocco
  const hideTimer = useRef(null);
  const lastTap = useRef(0);
  const barRef = useRef(null);

  // Lo stato vero è sull'elemento: ci si ri-renderizza ai suoi eventi.
  useEffect(() => {
    if (!video) return undefined;
    const rerender = () => force((n) => n + 1);
    const events = ['play', 'pause', 'timeupdate', 'durationchange', 'progress', 'volumechange', 'ratechange', 'loadedmetadata', 'resize', 'emptied'];
    for (const e of events) video.addEventListener(e, rerender);
    const onEnterPiP = () => setIsPiP(true);
    const onLeavePiP = () => setIsPiP(false);
    video.addEventListener('enterpictureinpicture', onEnterPiP);
    video.addEventListener('leavepictureinpicture', onLeavePiP);
    return () => {
      for (const e of events) video.removeEventListener(e, rerender);
      video.removeEventListener('enterpictureinpicture', onEnterPiP);
      video.removeEventListener('leavepictureinpicture', onLeavePiP);
    };
  }, [video]);

  useEffect(() => {
    const onChange = () => setIsFull(!!container && fullscreenElement() === container);
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, [container]);

  const paused = !video || video.paused;
  const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
  const current = scrub != null ? scrub * duration : video?.currentTime ?? 0;
  const pinned = paused || settingsOpen || scrub != null;

  // Attività → mostra; poi, se sta andando, nasconde dopo un attimo.
  function poke() {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
  }
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => { if (!paused) poke(); }, [paused]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = visible || pinned;

  function togglePlay() {
    if (!video) return;
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }
  function seekBy(delta) {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min((duration || Infinity) - 0.25, video.currentTime + delta));
  }
  function toggleMute() {
    if (video) video.muted = !video.muted;
  }

  async function toggleFullscreen() {
    if (!video) return;
    if (fullscreenElement()) {
      (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
      return;
    }
    const req = container?.requestFullscreen ?? container?.webkitRequestFullscreen;
    if (req) {
      try { await req.call(container); return; } catch { /* si prova quello del video */ }
    }
    // iPhone: niente schermo intero sugli elementi, solo quello nativo del video
    // (con i comandi di sistema).
    video.webkitEnterFullscreen?.();
  }

  async function togglePiP() {
    if (!video) return;
    try {
      if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
      if (video.readyState < 1) {
        await Promise.race([
          new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true })),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
      }
      await video.requestPictureInPicture();
    } catch { /* PiP rifiutato dal browser: resta com'era */ }
  }

  // Tastiera: solo dove il player è il protagonista (non nel riquadro flottante).
  useEffect(() => {
    if (compact || !video) return undefined;
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || settingsOpen) return;
      const k = e.key.toLowerCase();
      const actions = {
        ' ': togglePlay, k: togglePlay,
        j: () => seekBy(-SKIP_SECONDS), l: () => seekBy(SKIP_SECONDS),
        arrowleft: () => seekBy(-5), arrowright: () => seekBy(5),
        f: toggleFullscreen, m: toggleMute
      };
      // Le frecce su un controllo con focus (la barra) le gestisce lui.
      if (k.startsWith('arrow') && e.target !== document.body) return;
      const fn = actions[k];
      if (!fn) return;
      e.preventDefault();
      fn();
      poke();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Superficie: il mouse fa play/pausa, il tocco mostra/nasconde; doppio tocco ai lati ±10 s.
  function onSurfaceUp(e) {
    if (e.pointerType === 'mouse') {
      if (e.button === 0) { togglePlay(); poke(); }
      return;
    }
    const now = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (now - lastTap.current < DOUBLE_TAP_MS && (x < 0.4 || x > 0.6)) {
      const side = x < 0.4 ? 'left' : 'right';
      seekBy(side === 'left' ? -SKIP_SECONDS : SKIP_SECONDS);
      setFlash({ side, key: now });
      lastTap.current = 0;
      poke();
      return;
    }
    lastTap.current = now;
    if (shown && !pinned) { clearTimeout(hideTimer.current); setVisible(false); } else poke();
  }

  // Barra: trascinamento con il puntatore catturato, salto al rilascio.
  function fractionAt(clientX) {
    const r = barRef.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }
  function onBarDown(e) {
    if (!duration) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrub(fractionAt(e.clientX));
  }
  function onBarMove(e) {
    if (scrub != null) setScrub(fractionAt(e.clientX));
  }
  function onBarUp(e) {
    if (scrub == null) return;
    const f = fractionAt(e.clientX);
    setScrub(null);
    if (video && duration) video.currentTime = f * duration;
    poke();
  }
  function onBarKey(e) {
    const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -60, PageUp: 60 }[e.key];
    if (step == null) return;
    e.preventDefault();
    seekBy(step);
    poke();
  }

  // Parte già scaricata/convertita: l'intervallo bufferizzato che contiene il punto attuale.
  let bufferedEnd = 0;
  if (video && duration) {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= video.currentTime + 0.5 && b.end(i) > bufferedEnd) bufferedEnd = b.end(i);
    }
  }
  const pct = duration ? (current / duration) * 100 : 0;
  const bufPct = duration ? (bufferedEnd / duration) * 100 : 0;

  const canPiP = !compact && typeof document !== 'undefined' && document.pictureInPictureEnabled && quality !== 'audio';
  const canMinimize = !compact && miniEnabled && typeof window !== 'undefined' && window.matchMedia('(min-width: 641px)').matches;

  return (
    <div
      className={`pc${shown ? ' pc-on' : ''}${compact ? ' pc-compact' : ''}`}
      onPointerMove={(e) => { if (e.pointerType === 'mouse') poke(); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !pinned) { clearTimeout(hideTimer.current); setVisible(false); } }}
    >
      <div
        className="pc-surface"
        onPointerUp={onSurfaceUp}
        onDoubleClick={(e) => { if (!compact) { e.preventDefault(); toggleFullscreen(); } }}
      />

      {flash && (
        <div key={flash.key} className={`pc-flash ${flash.side}`} onAnimationEnd={() => setFlash(null)}>
          {flash.side === 'left' ? <RotateCcw size={22} /> : <RotateCw size={22} />}
          <span>{SKIP_SECONDS} s</span>
        </div>
      )}

      {/* Telefono: play/pausa e ±10 s grandi al centro, come nelle app video. */}
      {!compact && (
        <div className="pc-center">
          <button type="button" className="pc-btn pc-skip" onClick={() => { seekBy(-SKIP_SECONDS); poke(); }} aria-label="Indietro di 10 secondi"><RotateCcw size={26} /></button>
          <button type="button" className="pc-btn pc-big" onClick={() => { togglePlay(); poke(); }} aria-label={paused ? 'Riproduci' : 'Pausa'}>
            {paused ? <Play size={34} fill="currentColor" /> : <Pause size={34} fill="currentColor" />}
          </button>
          <button type="button" className="pc-btn pc-skip" onClick={() => { seekBy(SKIP_SECONDS); poke(); }} aria-label="Avanti di 10 secondi"><RotateCw size={26} /></button>
        </div>
      )}

      <div className="pc-bottom">
        <div
          ref={barRef}
          className={`pc-bar${scrub != null ? ' dragging' : ''}`}
          role="slider"
          tabIndex={0}
          aria-label="Posizione"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${time(current)} di ${time(duration)}`}
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={() => setScrub(null)}
          onKeyDown={onBarKey}
        >
          <div className="pc-bar-track">
            <div className="pc-bar-buf" style={{ width: `${bufPct}%` }} />
            <div className="pc-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="pc-bar-knob" style={{ left: `${pct}%` }} />
          {scrub != null && <div className="pc-bar-tip" style={{ left: `${pct}%` }}>{time(current)}</div>}
        </div>

        <div className="pc-row">
          <button type="button" className="pc-btn" onClick={togglePlay} aria-label={paused ? 'Riproduci' : 'Pausa'} title={paused ? 'Riproduci (K)' : 'Pausa (K)'}>
            {paused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}
          </button>
          {!compact && (
            <span className="pc-volume">
              <button type="button" className="pc-btn" onClick={toggleMute} aria-label={video?.muted ? 'Riattiva audio' : 'Disattiva audio'} title={video?.muted ? 'Riattiva audio (M)' : 'Disattiva audio (M)'}>
                {video?.muted || video?.volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
              </button>
              <input
                type="range" min="0" max="1" step="0.05"
                aria-label="Volume"
                value={video?.muted ? 0 : video?.volume ?? 1}
                onChange={(e) => { if (!video) return; video.volume = Number(e.target.value); video.muted = video.volume === 0; }}
              />
            </span>
          )}
          <span className="pc-time">{time(current)} <span className="pc-time-sep">/</span> {time(duration)}</span>
          <span className="pc-spacer" />
          {!compact && (
            <button
              type="button"
              className={`pc-btn pc-gear${settingsOpen ? ' on' : ''}`}
              onClick={() => setSettingsOpen(!settingsOpen)}
              aria-label="Impostazioni"
              title="Velocità e qualità"
            >
              <Settings size={19} />
              {video && video.playbackRate !== 1 && <span className="pc-badge">{video.playbackRate}×</span>}
              {quality === 'audio' && <span className="pc-badge">audio</span>}
            </button>
          )}
          {canPiP && (
            <button type="button" className="pc-btn" onClick={togglePiP} aria-label={isPiP ? 'Esci da Picture in Picture' : 'Picture in Picture'} title={isPiP ? 'Esci da Picture in Picture' : 'Picture in Picture'}>
              <PictureInPicture2 size={19} />
            </button>
          )}
          {canMinimize && (
            <button type="button" className="pc-btn" onClick={() => setMinimized(true)} aria-label="Minimizza nel riquadro flottante" title="Minimizza nel riquadro flottante">
              <Minimize2 size={18} />
            </button>
          )}
          {!compact && (
            <button type="button" className="pc-btn" onClick={toggleFullscreen} aria-label={isFull ? 'Esci da schermo intero' : 'Schermo intero'} title={isFull ? 'Esci da schermo intero (F)' : 'Schermo intero (F)'}>
              {isFull ? <Minimize size={19} /> : <Maximize size={19} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Menu dell'ingranaggio: due voci (Velocità, Qualità) che aprono il proprio
// elenco, come su YouTube. Riusa .menu-list: dal basso su telefono.
export function PlayerSettings({ video, quality, qualities, info, onQuality, onClose }) {
  const [view, setView] = useState('main');
  const rate = video?.playbackRate ?? 1;
  const back = (
    <button type="button" className="menu-item pc-menu-back" onClick={() => setView('main')}>
      <ChevronLeft size={15} />{view === 'speed' ? 'Velocità' : 'Qualità'}
    </button>
  );
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="menu-list pc-settings" role="menu">
        {view === 'main' && (
          <>
            <button type="button" className="menu-item" onClick={() => setView('speed')}>
              <Gauge size={15} />Velocità<span className="pc-menu-val">{rate === 1 ? 'Normale' : `${rate}×`}</span><ChevronRight size={14} />
            </button>
            <button type="button" className="menu-item" onClick={() => setView('quality')}>
              <Layers size={15} />Qualità<span className="pc-menu-val">{qualityLabel(quality ?? 'auto', info, video?.videoHeight)}</span><ChevronRight size={14} />
            </button>
          </>
        )}
        {view === 'speed' && (
          <>
            {back}
            {SPEEDS.map((sp) => (
              <button
                key={sp} type="button" className="menu-item"
                onClick={() => { if (video) { video.playbackRate = sp; video.defaultPlaybackRate = sp; } onClose(); }}
              >
                <span className="pc-menu-check">{sp === rate && <Check size={15} />}</span>{sp === 1 ? 'Normale' : `${sp}×`}
              </button>
            ))}
          </>
        )}
        {view === 'quality' && (
          <>
            {back}
            {qualities.map((q) => (
              <button key={q} type="button" className="menu-item" onClick={() => { onQuality(q); onClose(); }}>
                <span className="pc-menu-check">{q === quality && <Check size={15} />}</span>
                {q === quality ? qualityLabel(q, info, video?.videoHeight) : qualityLabel(q, info)}
              </button>
            ))}
          </>
        )}
      </div>
    </>
  );
}
