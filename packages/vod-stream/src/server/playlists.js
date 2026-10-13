// Le playlist HLS. Sono di tipo VOD e complete fin dalla prima richiesta:
// calcolate dalla durata, senza aspettare ffmpeg. Per il player il video ha
// subito la sua lunghezza vera (niente "in diretta") e si può saltare in
// qualunque punto; il segmento richiesto si produce in quel momento.

const CODECS_VIDEO = 'avc1.640028'; // H.264 High 4.0: quello che produce l'encoder
const CODECS_AUDIO = 'mp4a.40.2';   // AAC-LC

export function segmentCount(duration, segmentSeconds) {
  return Math.max(1, Math.ceil(duration / segmentSeconds - 1e-6));
}

export function masterPlaylist(renditions, { hasAudio, fps }) {
  const codecs = hasAudio ? `${CODECS_VIDEO},${CODECS_AUDIO}` : CODECS_VIDEO;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  // L'ordine conta: Safari parte dalla PRIMA variante elencata, e la prima è
  // quella "di partenza" (veloce da produrre). Poi sale da solo.
  for (const r of renditions) {
    const bandwidth = r.videoBitrate + (hasAudio ? r.audioBitrate : 0);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bandwidth * 1.2)},AVERAGE-BANDWIDTH=${bandwidth},` +
      `RESOLUTION=${r.width}x${r.height},CODECS="${codecs}"${fps ? `,FRAME-RATE=${fps.toFixed(3)}` : ''}`,
      `${encodeURIComponent(r.name)}/index.m3u8`
    );
  }
  return `${lines.join('\n')}\n`;
}

export function mediaPlaylist(duration, segmentSeconds) {
  const count = segmentCount(duration, segmentSeconds);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD'
  ];
  for (let i = 0; i < count; i++) {
    const len = i === count - 1 ? duration - i * segmentSeconds : segmentSeconds;
    lines.push(`#EXTINF:${Math.max(len, 0.001).toFixed(3)},`, `${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}
