import { useEffect, useState } from 'react';
import { getPlayback } from '../api/client.js';

// Quale indirizzo dare al <video>: il file così com'è, o la sua versione HLS
// convertita al volo dal server (vedi streamService.js nel core).
//
// I video si scaricano alla qualità massima (VP9/AV1 + Opus, spesso MKV o
// WebM): Chrome e Firefox li leggono, Safari — e quindi iPhone e iPad — no. HLS
// invece è il formato di streaming nativo di Safari, e il server lo produce in
// H.264 + AAC, che parte ovunque.
//
// La regola:
//   - MKV con un browser che sa riprodurre HLS → HLS. Safari è l'unico che
//     dichiara HLS nativo, e un MKV non lo apre mai, qualunque codec contenga
//     (canPlayType non aiuta: Chrome legge gli MKV ma risponde "" lo stesso);
//   - altrimenti si chiede al browser se legge il tipo esatto del file (con i
//     codec misurati da ffprobe): se no, e se sa riprodurre HLS → HLS;
//   - in tutti gli altri casi il file, come prima.
// E un paracadute: se il file dà errore in riproduzione e c'è HLS, si passa lì
// (onError) — canPlayType a volte promette più di quanto il browser mantenga.

let probe = null;
function canPlay(type) {
  probe ??= document.createElement('video');
  return probe.canPlayType(type) !== '';
}
const HLS = 'application/vnd.apple.mpegurl';

function chooseSource(directUrl, info) {
  if (!info?.hlsUrl || !canPlay(HLS)) return directUrl;
  if (info.container === 'video/x-matroska') return info.hlsUrl;
  return canPlay(info.mimeType) ? directUrl : info.hlsUrl;
}

export function usePlaybackSource(current) {
  const [state, setState] = useState({ id: null, src: null, hlsUrl: null });
  const id = current?.id ?? null;
  const directUrl = current?.videoUrl ?? null;

  useEffect(() => {
    if (!id || !directUrl) {
      setState({ id, src: directUrl, hlsUrl: null });
      return undefined;
    }
    let cancelled = false;
    // Finché non si sa il tipo, niente src: partire col file e cambiare dopo
    // farebbe scaricare a Safari l'inizio di un file che non sa leggere.
    setState({ id, src: null, hlsUrl: null });
    getPlayback(id)
      .then((info) => {
        if (!cancelled) setState({ id, src: chooseSource(directUrl, info), hlsUrl: info.hlsUrl ?? null });
      })
      .catch(() => {
        // Server vecchio o ffprobe che non risponde: il file, come sempre.
        if (!cancelled) setState({ id, src: directUrl, hlsUrl: null });
      });
    return () => { cancelled = true; };
  }, [id, directUrl]);

  function onError() {
    setState((s) => (s.hlsUrl && s.src !== s.hlsUrl && canPlay(HLS) ? { ...s, src: s.hlsUrl } : s));
  }

  return { src: state.id === id ? state.src : null, isHls: !!state.src && state.src === state.hlsUrl, onError };
}
