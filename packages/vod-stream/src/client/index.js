// vod-stream — lato browser. Nessuna dipendenza: hls.js si passa da fuori
// (loadHls), e serve solo dove HLS non è nativo (Chrome/Firefox/Android) E il
// file originale non si può riprodurre.
//
//   const player = await attachVideo(videoEl, {
//     infoUrl: '/stream/abc123/info.json',
//     directUrl: '/media/abc123.mkv',
//     loadHls: () => import('hls.js').then((m) => m.default),
//   });
//   ...
//   player.destroy();

const HLS_MIME = 'application/vnd.apple.mpegurl';

/**
 * Il file originale va bene così com'è su questo browser?
 * - MKV con HLS nativo (Safari, iPhone): no — Safari non apre gli MKV, qualunque
 *   codec contengano, e canPlayType non lo dice in modo affidabile.
 * - MKV altrove (Chrome, Firefox): sì — li leggono, anche se canPlayType
 *   risponde "" per video/x-matroska. Se poi non va, c'è il ripiego su errore.
 * - Tutto il resto: lo dice canPlayType con il tipo completo (codec compresi).
 */
export function canPlayDirect(video, info) {
  if (!info?.mimeType) return true;
  const nativeHls = video.canPlayType(HLS_MIME) !== '';
  if (info.container === 'video/x-matroska') return !nativeHls;
  return video.canPlayType(info.mimeType) !== '';
}

/**
 * Collega un <video> a un video servito da vod-stream: il file originale se il
 * browser lo legge (massima qualità, nessun carico sul server), altrimenti HLS
 * adattivo convertito al volo.
 *
 * @param {HTMLVideoElement} video
 * @param {object} o
 * @param {string} o.infoUrl         l'indirizzo di <id>/info.json
 * @param {string} [o.directUrl]     il file originale; senza, sempre HLS
 * @param {() => Promise<any>} [o.loadHls]  restituisce la classe Hls di hls.js
 * @param {boolean} [o.preferHls]    usa HLS anche se il file si potrebbe leggere
 * @param {number} [o.startTime]     secondi da cui partire
 * @param {object} [o.hlsConfig]     opzioni in più per hls.js
 * @param {(mode: 'direct'|'hls', url: string) => void} [o.onModeChange]
 * @returns {Promise<{ mode: string, info: object|null, destroy: () => void }>}
 */
export async function attachVideo(video, o) {
  const state = { mode: null, info: null, hls: null, destroyed: false, cleanup: [] };
  const base = typeof location !== 'undefined' ? location.href : undefined;
  const infoUrl = new URL(o.infoUrl, base).href;

  try {
    const res = await fetch(infoUrl);
    if (res.ok) state.info = await res.json();
  } catch { /* server irraggiungibile: si prova il file */ }
  if (state.destroyed) return controller();

  const masterUrl = state.info ? new URL(state.info.masterPlaylist, infoUrl).href : null;
  const nativeHls = video.canPlayType(HLS_MIME) !== '';

  function on(type, fn, opts) {
    video.addEventListener(type, fn, opts);
    state.cleanup.push(() => video.removeEventListener(type, fn, opts));
  }

  function seekOnceReady(t) {
    if (!(t > 0)) return;
    on('loadedmetadata', () => { video.currentTime = t; }, { once: true });
  }

  function setMode(mode, url) {
    state.mode = mode;
    o.onModeChange?.(mode, url);
  }

  function useDirect(startTime) {
    video.src = o.directUrl;
    seekOnceReady(startTime);
    setMode('direct', o.directUrl);
    // Ripiego: canPlayType a volte promette più di quanto il browser mantenga.
    // Se il file dà errore si passa a HLS dal punto in cui si era.
    if (masterUrl) {
      let done = false;
      const fallback = () => {
        if (done || state.destroyed || state.mode !== 'direct') return;
        done = true;
        const t = video.currentTime;
        const wasPlaying = !video.paused || video.autoplay;
        useHls(t).then(() => { if (wasPlaying) video.play().catch(() => {}); });
      };
      on('error', fallback, { once: true });
      // Peggio dell'errore: un codec video che il browser non sa decodificare
      // ma con l'audio sì (Chrome con certi HEVC/AV1). Nessun errore, parte
      // l'audio e l'immagine resta la copertina. Si riconosce dalla larghezza
      // 0 a metadati caricati.
      if (state.info?.videoCodec) {
        on('loadedmetadata', () => { if (video.videoWidth === 0) fallback(); }, { once: true });
      }
    }
  }

  async function useHls(startTime) {
    if (nativeHls) {
      video.src = masterUrl;
      seekOnceReady(startTime);
      setMode('hls', masterUrl);
      return;
    }
    const Hls = o.loadHls ? await o.loadHls() : null;
    if (state.destroyed) return;
    if (Hls?.isSupported?.()) {
      const hls = new Hls({
        startPosition: startTime > 0 ? startTime : -1,
        // Si parte dalla prima qualità del master (la più veloce), poi decide l'ABR.
        startLevel: 0,
        capLevelToPlayerSize: true,
        maxBufferLength: 30,
        ...o.hlsConfig
      });
      hls.loadSource(masterUrl);
      hls.attachMedia(video);
      state.hls = hls;
      setMode('hls', masterUrl);
      return;
    }
    // Né HLS nativo né hls.js: resta solo il file.
    if (o.directUrl) useDirect(startTime);
  }

  const direct = o.directUrl && !o.preferHls && (!masterUrl || canPlayDirect(video, state.info));
  if (direct) useDirect(o.startTime);
  else if (masterUrl) await useHls(o.startTime);
  else if (o.directUrl) useDirect(o.startTime);

  return controller();

  function controller() {
    return {
      get mode() { return state.mode; },
      get info() { return state.info; },
      destroy() {
        state.destroyed = true;
        for (const fn of state.cleanup) fn();
        state.cleanup = [];
        state.hls?.destroy();
        state.hls = null;
        video.removeAttribute('src');
        video.load();
      }
    };
  }
}

/**
 * Avvisa quando il video sta caricando (per mostrare un'animazione di
 * buffering): all'avvio dopo play(), dopo un salto, quando la rete non tiene
 * il passo. In pausa non conta come buffering. Restituisce la funzione per
 * smettere di ascoltare.
 *
 * @param {HTMLVideoElement} video
 * @param {(buffering: boolean) => void} onChange
 */
export function watchBuffering(video, onChange) {
  let waiting = false;
  let seeking = false;
  let last = null;
  const emit = () => {
    const now = seeking || (waiting && !video.paused);
    if (now !== last) { last = now; onChange(now); }
  };
  const handlers = {
    waiting: () => { waiting = true; emit(); },
    seeking: () => { seeking = true; emit(); },
    seeked: () => { seeking = false; emit(); },
    playing: () => { waiting = false; emit(); },
    canplay: () => { waiting = false; emit(); },
    pause: emit,
    play: () => { if (video.readyState < 3) waiting = true; emit(); },
    emptied: () => { waiting = false; seeking = false; emit(); },
    ended: () => { waiting = false; emit(); },
    error: () => { waiting = false; seeking = false; emit(); }
  };
  for (const [t, fn] of Object.entries(handlers)) video.addEventListener(t, fn);
  emit();
  return () => { for (const [t, fn] of Object.entries(handlers)) video.removeEventListener(t, fn); };
}
