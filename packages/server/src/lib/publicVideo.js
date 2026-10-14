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
  // L'impronta come cache-bust: una copertina sostituita col wizard tiene lo
  // stesso nome di file, e il browser mostrerebbe ancora quella vecchia.
  if (local) return thumbFileUrl(local, video.thumbnail?.sha256);
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
function thumbFileUrl(rel, version) {
  if (!rel) return null;
  return `/media/thumbnails/${encodeRelPath(rel)}${version ? `?v=${encodeURIComponent(String(version).slice(0, 12))}` : ''}`;
}

// Valori dei metadati con dentro una copertina ({ file, sha }) → con l'URL.
function withThumbUrl(field, value) {
  if (field !== 'thumbnail' || !value?.file) return value;
  return { ...value, url: thumbFileUrl(value.file, value.sha) };
}

function publicReview(review) {
  if (!review) return null;
  const fields = {};
  for (const [f, v] of Object.entries(review.fields ?? {})) {
    fields[f] = { current: withThumbUrl(f, v?.current), incoming: withThumbUrl(f, v?.incoming) };
  }
  return { ...review, fields };
}

export function toPublicVideo(video, creatorIndex = {}) {
  const key = channelKey(video);
  const creator = key ? creatorIndex[key] : null;
  return {
    ...video,
    // Categoria derivata dai flag ortogonali (M25): calcolata nel core, così il
    // frontend mostra badge/chip/ordina senza reimplementare la regola. I flag
    // grezzi (presence/download/hidden/removedAt) restano comunque nell'oggetto.
    category: videoCategory(video),
    pendingReview: publicReview(video.pendingReview),
    metadataHistory: (video.metadataHistory ?? []).map((e) => ({ ...e, from: withThumbUrl(e.field, e.from), to: withThumbUrl(e.field, e.to) })),
    locks: video.locks ?? [],
    videoUrl: video.video?.localPath ? `/media/videos/${encodeRelPath(video.video.localPath)}` : null,
    thumbnailUrl: resolveThumbnailUrl(video),
    channel: {
      ...video.channel,
      profileId: creator?.profileId ?? null,
      avatarUrl: avatarUrl(creator?.avatar)
    }
  };
}

// I campi che servono solo alla pagina del video (descrizione, tag, capitoli,
// la cronologia dei metadati…) o a nessuno (l'elenco di tutte le copertine di
// YouTube, da solo metà del peso). Negli elenchi non viaggiano: la Libreria con
// qualche centinaio di video passava da ~4 MB a una frazione.
const DETAIL_ONLY = ['description', 'tags', 'thumbnails', 'chapters', 'categories', 'subtitleLanguagesAvailable', 'playlistContext', 'statsAtDownload', 'metadataHistory'];

/** Il video per gli elenchi (Libreria, creator, ricerca): senza i campi del solo dettaglio. */
export function toListVideo(video, creatorIndex = {}) {
  const slim = { ...video };
  for (const f of DETAIL_ONLY) delete slim[f];
  return toPublicVideo(slim, creatorIndex);
}
