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
 * adattivo convertito al volo. La qualità si può poi forzare con setQuality.
 *
 * Qualità (stringhe):
 *   'auto'      il file se il browser lo legge, altrimenti HLS adattivo
 *   'original'  il file originale
 *   '720p', …   una sola variante HLS (quelle di info.renditions)
 *   'audio'     solo l'audio, in HLS (se il video ha l'audio)
 *
 * @param {HTMLVideoElement} video
 * @param {object} o
 * @param {string} o.infoUrl         l'indirizzo di <id>/info.json
 * @param {string} [o.directUrl]     il file originale; senza, sempre HLS
 * @param {() => Promise<any>} [o.loadHls]  restituisce la classe Hls di hls.js
 * @param {boolean} [o.preferHls]    usa HLS anche se il file si potrebbe leggere
 * @param {string} [o.quality]       qualità di partenza (predefinita 'auto'); se
 *                                   non c'è per questo video si usa 'auto'
 * @param {number} [o.startTime]     secondi da cui partire
 * @param {object} [o.hlsConfig]     opzioni in più per hls.js
 * @param {(mode: 'direct'|'hls', url: string) => void} [o.onModeChange]
 * @param {(quality: string) => void} [o.onQualityChange]
 * @param {(e: { mode: string, code: number|null }) => void} [o.onError]
 *        la riproduzione è fallita e non c'è un ripiego (file vuoto o
 *        rovinato, conversione impossibile)
 * @returns {Promise<{ mode: string, quality: string, qualities: string[], info: object|null,
 *   setQuality: (q: string) => Promise<void>, destroy: () => void }>}
 */
export async function attachVideo(video, o) {
  const state = {
    mode: null, quality: null, info: null, hls: null, destroyed: false,
    directBroken: false,
    srcCleanup: []   // listener della sorgente in uso, tolti a ogni cambio
  };
  const base = typeof location !== 'undefined' ? location.href : undefined;
  const infoUrl = new URL(o.infoUrl, base).href;

  try {
    const res = await fetch(infoUrl);
    if (res.ok) state.info = await res.json();
  } catch { /* server irraggiungibile: si prova il file */ }
  if (state.destroyed) return controller();

  const masterUrl = state.info ? new URL(state.info.masterPlaylist, infoUrl).href : null;
  const audioUrl = state.info?.audioPlaylist ? new URL(state.info.audioPlaylist, infoUrl).href : null;
  const renditionNames = (state.info?.renditions ?? []).map((r) => r.name);
  const nativeHls = video.canPlayType(HLS_MIME) !== '';
  const hlsPossible = nativeHls || !!o.loadHls;

  function on(type, fn, opts) {
    video.addEventListener(type, fn, opts);
    state.srcCleanup.push(() => video.removeEventListener(type, fn, opts));
  }

  function resetSource() {
    for (const fn of state.srcCleanup) fn();
    state.srcCleanup = [];
    state.hls?.destroy();
    state.hls = null;
  }

  // Nessun ripiego possibile: lo dice a chi usa il player.
  function fail() {
    if (state.destroyed) return;
    o.onError?.({ mode: state.mode, code: video.error?.code ?? null });
  }

  function seekOnceReady(t) {
    if (!(t > 0)) return;
    on('loadedmetadata', () => { video.currentTime = t; }, { once: true });
  }

  function setMode(mode, url, quality) {
    state.mode = mode;
    o.onModeChange?.(mode, url);
    if (state.quality !== quality) {
      state.quality = quality;
      o.onQualityChange?.(quality);
    }
  }

  const directPlayable = () => !!o.directUrl && !state.directBroken && (!masterUrl || canPlayDirect(video, state.info));

  function useDirect(startTime, quality) {
    video.src = o.directUrl;
    seekOnceReady(startTime);
    setMode('direct', o.directUrl, quality);
    // Ripiego: canPlayType a volte promette più di quanto il browser mantenga.
    // Se il file dà errore si passa a HLS dal punto in cui si era.
    if (!masterUrl) { on('error', fail, { once: true }); return; }
    let done = false;
    const fallback = () => {
      if (done || state.destroyed || state.mode !== 'direct') return;
      done = true;
      state.directBroken = true;
      const t = video.currentTime;
      const wasPlaying = !video.paused || video.autoplay;
      resetSource();
      load('auto', t).then(() => { if (wasPlaying) video.play().catch(() => {}); });
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

  // HLS: il master (adattivo) o una sola playlist (una qualità, o l'audio).
  // hls.js accetta anche una playlist singola, quindi il percorso è lo stesso.
  async function useHls(startTime, url, quality) {
    if (nativeHls) {
      video.src = url;
      on('error', fail, { once: true });
      seekOnceReady(startTime);
      setMode('hls', url, quality);
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
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(); });
      hls.loadSource(url);
      hls.attachMedia(video);
      state.hls = hls;
      setMode('hls', url, quality);
      return;
    }
    // Né HLS nativo né hls.js: resta solo il file.
    if (o.directUrl) useDirect(startTime, 'original');
  }

  async function load(quality, startTime) {
    if (quality === 'original' && o.directUrl && !state.directBroken) return useDirect(startTime, 'original');
    if (quality === 'audio' && audioUrl && hlsPossible) return useHls(startTime, audioUrl, 'audio');
    if (renditionNames.includes(quality) && masterUrl && hlsPossible) {
      return useHls(startTime, new URL(`${encodeURIComponent(quality)}/index.m3u8`, masterUrl).href, quality);
    }
    if (!o.preferHls && directPlayable()) return useDirect(startTime, 'auto');
    if (masterUrl) return useHls(startTime, masterUrl, 'auto');
    if (o.directUrl) return useDirect(startTime, 'auto');
  }

  await load(o.quality ?? 'auto', o.startTime);

  return controller();

  function controller() {
    return {
      get mode() { return state.mode; },
      get quality() { return state.quality; },
      get info() { return state.info; },
      /** Le qualità che si possono chiedere a setQuality, nell'ordine da mostrare. */
      get qualities() {
        const list = ['auto'];
        if (o.directUrl && !state.directBroken && (directPlayable() || !masterUrl)) list.push('original');
        if (masterUrl && hlsPossible) list.push(...[...renditionNames].sort((a, b) => parseInt(b, 10) - parseInt(a, 10)));
        if (audioUrl && hlsPossible) list.push('audio');
        return list;
      },
      /** Cambia qualità restando allo stesso punto, in pausa o in riproduzione com'era. */
      async setQuality(quality) {
        if (state.destroyed || quality === state.quality) return;
        const t = video.currentTime;
        const wasPlaying = !video.paused;
        const rate = video.playbackRate;
        resetSource();
        await load(quality, t);
        if (state.destroyed) return;
        // Un nuovo src riporta la velocità a defaultPlaybackRate.
        video.defaultPlaybackRate = rate;
        video.playbackRate = rate;
        if (wasPlaying) video.play().catch(() => {});
      },
      destroy() {
        state.destroyed = true;
        resetSource();
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
