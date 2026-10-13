import { channelKey, videoCategory } from '@catalog/core';

// video.localPath è relativo a videosDir, thumbnail.localPath a thumbnailsDir
// (possono includere sottocartelle per creator, vedi "Archivio canonico per
// creator" in documentazione.md). Qui si aggiunge l'URL pronto all'uso per il
// frontend, incapsulando dove vive il media server-side.
function encodeRelPath(relPath) {
  return relPath
    .split(/[\\/]/)
    .map(encodeURIComponent)
    .join('/');
}

// URL della copertina, con fallback per i video non ancora arricchiti (fase 2):
//  1. copertina locale già in cache (media/thumbnails/) → l'archivio locale;
//  2. altrimenti la sourceUrl remota se catturata;
//  3. altrimenti, per YouTube, la si deriva dall'id (pattern stabile ytimg).
// Così un video appena aggiunto via flat-playlist mostra subito una copertina
// (remota) invece di un riquadro vuoto, sostituita da quella locale appena
// enrichSource la scarica. Per gli altri estrattori senza sourceUrl → null.
function resolveThumbnailUrl(video) {
  const local = video.thumbnail?.localPath;
  if (local) return `/media/thumbnails/${encodeRelPath(local)}`;
  const source = video.thumbnail?.sourceUrl;
  if (source) return source;
  if (video.extractor === 'youtube' && video.id) {
    // mqdefault (320x180, 16:9 pulito, sempre disponibile) invece di hqdefault
    // (4:3 con bande nere di letterbox — vedi bug noto sulle copertine).
    return `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;
  }
  return null;
}

// URL di una foto della cartella avatar, con la data come cache-bust (M42):
// una foto riscritta con lo stesso nome resterebbe altrimenti quella vecchia.
export function avatarUrl(file) {
  return file?.localPath
    ? `/media/avatars/${encodeRelPath(file.localPath)}?v=${encodeURIComponent(file.version ?? '')}`
    : null;
}

// creatorIndex: channelKey → { profileId, avatar } (core getCreatorIndex). La
// foto accanto a un video è quella del suo profilo creator.
export function toPublicVideo(video, creatorIndex = {}) {
  const key = channelKey(video);
  const creator = key ? creatorIndex[key] : null;
  return {
    ...video,
    // Categoria derivata dai flag ortogonali (M25): calcolata nel core, così il
    // frontend mostra badge/chip/ordina senza reimplementare la regola. I flag
    // grezzi (presence/download/hidden/removedAt) restano comunque nell'oggetto.
    category: videoCategory(video),
    videoUrl: video.video?.localPath ? `/media/videos/${encodeRelPath(video.video.localPath)}` : null,
    thumbnailUrl: resolveThumbnailUrl(video),
    channel: {
      ...video.channel,
      profileId: creator?.profileId ?? null,
      avatarUrl: avatarUrl(creator?.avatar)
    }
  };
}
