import { useEffect } from 'react';
import { getVideoEl } from '../lib/playerStore.js';
import { getNextAfter, useQueue } from '../lib/queueStore.js';

const SKIP_SECONDS = 10;

function artworkType(url) {
  const ext = /\.(\w+)(?:$|\?)/.exec(url)?.[1]?.toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext];
}

// Blocco schermo, Centro di controllo, cuffie e tasti multimediali (Media
// Session API): titolo, creator e copertina del video al posto dell'icona del
// sito, come Spotify e YouTube. Più i comandi: play/pausa, ±10 s, salto a un
// punto e "successivo" quando c'è una coda.
export function useMediaSession(current, goToNext) {
  useQueue(); // ricalcola hasNext quando la coda cambia
  const hasNext = !!current && !!getNextAfter(current.id);
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
    if (!ms) return undefined;
    if (!current) {
      ms.metadata = null;
      return undefined;
    }

    // L'artwork va con indirizzo assoluto: il sistema lo scarica fuori dalla pagina.
    const artwork = current.thumbnailUrl
      ? [{ src: new URL(current.thumbnailUrl, location.href).href, type: artworkType(current.thumbnailUrl) }]
      : [];
    ms.metadata = new MediaMetadata({
      title: current.title ?? '',
      artist: current.channelName ?? '',
      album: 'Ondo',
      artwork
    });

    const el = () => getVideoEl();
    // Con durata, posizione e velocità il blocco schermo mostra la barra giusta.
    const syncPosition = () => {
      const v = el();
      if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
      try {
        ms.setPositionState({ duration: v.duration, position: Math.min(v.currentTime, v.duration), playbackRate: v.playbackRate || 1 });
      } catch { /* valori fuori intervallo durante un cambio di sorgente */ }
    };
    const seekBy = (delta) => {
      const v = el();
      if (!v) return;
      v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.5, v.currentTime + delta));
      syncPosition();
    };
    const handlers = {
      play: () => el()?.play().catch(() => {}),
      pause: () => el()?.pause(),
      seekbackward: (d) => seekBy(-(d.seekOffset || SKIP_SECONDS)),
      seekforward: (d) => seekBy(d.seekOffset || SKIP_SECONDS),
      seekto: (d) => {
        const v = el();
        if (!v || d.seekTime == null) return;
        if (d.fastSeek && 'fastSeek' in v) v.fastSeek(d.seekTime); else v.currentTime = d.seekTime;
        syncPosition();
      },
      // Solo se in coda c'è davvero un successivo: altrimenti il tasto non compare.
      nexttrack: hasNext ? () => goToNext() : null
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch { /* azione non supportata da questo browser */ }
    }

    const v = el();
    const events = ['loadedmetadata', 'play', 'pause', 'seeked', 'ratechange'];
    for (const e of events) v?.addEventListener(e, syncPosition);
    syncPosition();

    return () => {
      for (const e of events) v?.removeEventListener(e, syncPosition);
      for (const action of Object.keys(handlers)) {
        try { ms.setActionHandler(action, null); } catch { /* idem */ }
      }
    };
  }, [current?.id, current?.title, current?.thumbnailUrl, current?.channelName, hasNext]); // eslint-disable-line react-hooks/exhaustive-deps
}
