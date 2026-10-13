import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { DOWNLOAD_STATE, PRESENCE } from '../catalog/catalogSchema.js';
import {
  channelToProfile, channelsInVideos, createProfile, ensureProfiles, hasUnassignedChannels, videoChannelKey
} from '../catalog/profiles.js';

// Profili creator (vedi catalog/profiles.js per il modello). Qui: letture con
// le statistiche calcolate dal catalogo, e le poche operazioni che l'utente fa
// a mano — rinominare, fissare in sidebar, unire o separare canali, scegliere
// la foto.

const CUSTOM_AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_CUSTOM_AVATAR_BYTES = 5 * 1024 * 1024;

// Un canale nuovo (arrivato con una sync) riceve il suo profilo alla prima
// lettura. Si scrive solo se serve: il controllo è in memoria.
async function catalogWithProfiles() {
  const catalog = await readCatalog();
  if (!hasUnassignedChannels(catalog)) return catalog;
  await updateCatalog((cat) => { ensureProfiles(cat); });
  return readCatalog();
}

function requireProfile(cat, id) {
  const profile = cat.profiles[id];
  if (!profile) throw new Error(`Profilo non trovato: ${id}`);
  return profile;
}

// La foto del profilo come file dentro la cartella degli avatar, con la data
// che serve a invalidare la cache del browser. null se il profilo non ne ha.
function avatarFile(cat, profile) {
  const a = profile.avatar;
  if (!a) return null;
  if (a.type === 'custom') return a.localPath ? { localPath: a.localPath, version: a.updatedAt } : null;
  const photo = cat.channelAvatars?.[a.channelKey];
  return photo?.localPath ? { localPath: photo.localPath, version: photo.fetchedAt } : null;
}

function emptyStats() {
  return { videoCount: 0, downloaded: 0, toDownload: 0, removed: 0, hidden: 0, failed: 0, bytesOnDisk: 0, lastAddedAt: null };
}

function addToStats(stats, video) {
  stats.videoCount += 1;
  if (video.hidden) stats.hidden += 1;
  if (video.presence === PRESENCE.REMOVED) stats.removed += 1;
  if (video.download === DOWNLOAD_STATE.DOWNLOADED) {
    stats.downloaded += 1;
    stats.bytesOnDisk += video.video?.sizeBytes ?? 0;
  } else if (video.download === DOWNLOAD_STATE.FAILED) {
    stats.failed += 1;
  } else if (video.presence === PRESENCE.PRESENT && !video.hidden && video.download === DOWNLOAD_STATE.NONE) {
    stats.toDownload += 1;
  }
  if (video.addedAt && (!stats.lastAddedAt || video.addedAt > stats.lastAddedAt)) stats.lastAddedAt = video.addedAt;
}

// Tutti i profili con le loro statistiche, in un solo giro sui video.
function summarize(cat) {
  const channels = channelsInVideos(cat);
  const byChannel = channelToProfile(cat);
  const acc = new Map();
  for (const profile of Object.values(cat.profiles)) {
    acc.set(profile.id, { stats: emptyStats(), sources: new Map() });
  }
  for (const video of Object.values(cat.videos)) {
    const key = videoChannelKey(video);
    const entry = key ? acc.get(byChannel.get(key)) : null;
    if (!entry) continue;
    addToStats(entry.stats, video);
    for (const s of video.sources ?? []) {
      const src = entry.sources.get(s.sourceId) ?? { id: s.sourceId, name: cat.sources?.[s.sourceId]?.name ?? s.name ?? s.sourceId, count: 0 };
      src.count += 1;
      entry.sources.set(s.sourceId, src);
    }
  }

  return Object.values(cat.profiles).map((profile) => {
    const { stats, sources } = acc.get(profile.id);
    const profileChannels = profile.channelKeys.map((key) => {
      const c = channels.get(key);
      const photo = cat.channelAvatars?.[key];
      return {
        key,
        name: c?.name ?? key,
        count: c?.count ?? 0,
        photo: photo?.localPath ? { localPath: photo.localPath, version: photo.fetchedAt } : null,
        photoError: photo?.error ?? null
      };
    });
    const liveName = profileChannels.find((c) => c.count > 0)?.name ?? profileChannels[0]?.name;
    return {
      id: profile.id,
      name: profile.renamed ? profile.name : (liveName ?? profile.name),
      renamed: !!profile.renamed,
      pinned: !!profile.pinned,
      avatarType: profile.avatar?.type ?? null,
      avatarChannelKey: profile.avatar?.type === 'channel' ? profile.avatar.channelKey : null,
      avatar: avatarFile(cat, profile),
      channels: profileChannels,
      sources: [...sources.values()].sort((a, b) => b.count - a.count),
      ...stats,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    };
  });
}

/** I profili con almeno un video, ordinati per nome. */
export async function listProfiles() {
  const cat = await catalogWithProfiles();
  return summarize(cat)
    .filter((p) => p.videoCount > 0)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'it', { sensitivity: 'base' }));
}

export async function getProfile(id) {
  const cat = await catalogWithProfiles();
  requireProfile(cat, id);
  return summarize(cat).find((p) => p.id === id);
}

/** I video del profilo (tutti i suoi canali, qualunque stato). */
export async function listProfileVideos(id) {
  const cat = await catalogWithProfiles();
  const keys = new Set(requireProfile(cat, id).channelKeys);
  return Object.values(cat.videos)
    .filter((v) => keys.has(videoChannelKey(v)))
    .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
}

/** Il profilo a cui appartiene un canale (per i vecchi link /channels/:key). */
export async function getProfileIdForChannel(channelKey) {
  const cat = await catalogWithProfiles();
  return channelToProfile(cat).get(channelKey) ?? null;
}

/**
 * Indice per le risposte dei video: channelKey → { profileId, profileName,
 * avatar: { localPath, version } | null }. La foto mostrata accanto a un video
 * è quella del suo profilo.
 */
export async function getCreatorIndex() {
  const cat = await catalogWithProfiles();
  const index = {};
  for (const profile of Object.values(cat.profiles)) {
    const entry = { profileId: profile.id, avatar: avatarFile(cat, profile) };
    for (const key of profile.channelKeys) index[key] = entry;
  }
  return index;
}

// --- Modifiche

function touch(profile) {
  profile.updatedAt = new Date().toISOString();
}

function removeCustomAvatarFile(profile) {
  if (profile.avatar?.type !== 'custom' || !profile.avatar.localPath) return;
  const file = path.join(getPaths().avatarsDir, profile.avatar.localPath);
  if (existsSync(file)) unlinkSync(file);
}

/** Rinomina. Un nome vuoto torna a seguire quello del canale. */
export async function renameProfile(id, name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean.length > 120) throw new Error('Nome troppo lungo (massimo 120 caratteri).');
  await updateCatalog((cat) => {
    const profile = requireProfile(cat, id);
    profile.name = clean || profile.name;
    profile.renamed = !!clean;
    touch(profile);
  });
  return getProfile(id);
}

export async function setProfilePinned(id, pinned) {
  await updateCatalog((cat) => {
    const profile = requireProfile(cat, id);
    profile.pinned = !!pinned;
    touch(profile);
  });
  return getProfile(id);
}

/**
 * Sposta dei canali dentro il profilo `id`. Un canale sta in un solo profilo:
 * viene tolto da quello in cui era, e i profili rimasti senza canali spariscono.
 * Se il profilo di arrivo non ha una foto, prende quella del primo profilo
 * assorbito che ne aveva una.
 */
export async function mergeChannelsIntoProfile(id, channelKeys) {
  if (!Array.isArray(channelKeys) || channelKeys.length === 0) throw new Error('Nessun canale da unire.');
  await updateCatalog((cat) => {
    const target = requireProfile(cat, id);
    const known = channelsInVideos(cat);
    const owners = channelToProfile(cat);
    for (const key of channelKeys) {
      if (!known.has(key)) throw new Error(`Canale non trovato: ${key}`);
      const fromId = owners.get(key);
      if (fromId === id) continue;
      const from = fromId ? cat.profiles[fromId] : null;
      if (from) {
        from.channelKeys = from.channelKeys.filter((k) => k !== key);
        const fromPhoto = from.avatar;
        if (from.avatar?.type === 'channel' && from.avatar.channelKey === key) {
          const other = from.channelKeys.find((k) => cat.channelAvatars?.[k]?.localPath);
          from.avatar = other ? { type: 'channel', channelKey: other } : null;
        }
        if (!target.avatar && fromPhoto && from.channelKeys.length === 0) target.avatar = { ...fromPhoto };
        else if (!target.avatar && fromPhoto?.type === 'channel' && fromPhoto.channelKey === key) target.avatar = { ...fromPhoto };
        if (from.channelKeys.length === 0) {
          // La foto caricata del profilo assorbito: tenuta solo se ora è del profilo di arrivo.
          if (!(target.avatar?.type === 'custom' && target.avatar.localPath === from.avatar?.localPath)) removeCustomAvatarFile(from);
          delete cat.profiles[fromId];
        } else {
          touch(from);
        }
      }
      target.channelKeys.push(key);
    }
    touch(target);
  });
  return getProfile(id);
}

/** Toglie un canale dal profilo e ne fa un profilo a sé. Ritorna il nuovo profilo. */
export async function splitChannelFromProfile(id, channelKey) {
  const newId = await updateCatalog((cat) => {
    const profile = requireProfile(cat, id);
    if (!profile.channelKeys.includes(channelKey)) throw new Error('Il canale non fa parte di questo profilo.');
    if (profile.channelKeys.length === 1) throw new Error('È l\'unico canale del profilo: non c\'è niente da separare.');
    profile.channelKeys = profile.channelKeys.filter((k) => k !== channelKey);
    if (profile.avatar?.type === 'channel' && profile.avatar.channelKey === channelKey) {
      const other = profile.channelKeys.find((k) => cat.channelAvatars?.[k]?.localPath);
      profile.avatar = other ? { type: 'channel', channelKey: other } : null;
    }
    touch(profile);
    const name = channelsInVideos(cat).get(channelKey)?.name ?? channelKey;
    return createProfile(cat, { channelKey, name }).id;
  });
  return getProfile(newId);
}

/** Foto del profilo = la foto (già scaricata) di uno dei suoi canali. */
export async function useChannelPhoto(id, channelKey) {
  await updateCatalog((cat) => {
    const profile = requireProfile(cat, id);
    if (!profile.channelKeys.includes(channelKey)) throw new Error('Il canale non fa parte di questo profilo.');
    if (!cat.channelAvatars?.[channelKey]?.localPath) throw new Error('La foto di questo canale non è ancora stata scaricata.');
    removeCustomAvatarFile(profile);
    profile.avatar = { type: 'channel', channelKey };
    touch(profile);
  });
  return getProfile(id);
}

/** Foto del profilo = un'immagine caricata dall'utente (JPEG, PNG o WebP). */
export async function setCustomPhoto(id, buffer, contentType) {
  const ext = CUSTOM_AVATAR_TYPES[String(contentType ?? '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw new Error('Formato non supportato: usa un\'immagine JPEG, PNG o WebP.');
  if (!buffer?.length) throw new Error('Immagine vuota.');
  if (buffer.length > MAX_CUSTOM_AVATAR_BYTES) throw new Error('Immagine troppo grande (massimo 5 MB).');
  const cat = await readCatalog();
  requireProfile(cat, id);

  // Nella cartella degli avatar, senza sottocartelle: così il backup la
  // include come tutte le altre foto.
  const avatarsDir = getPaths().avatarsDir;
  mkdirSync(avatarsDir, { recursive: true });
  const filename = `profilo-${id}.${ext}`;
  await writeFile(path.join(avatarsDir, filename), buffer);

  await updateCatalog((c) => {
    const profile = requireProfile(c, id);
    if (profile.avatar?.type === 'custom' && profile.avatar.localPath !== filename) removeCustomAvatarFile(profile);
    profile.avatar = { type: 'custom', localPath: filename, updatedAt: new Date().toISOString() };
    touch(profile);
  });
  return getProfile(id);
}

export async function clearProfilePhoto(id) {
  await updateCatalog((cat) => {
    const profile = requireProfile(cat, id);
    removeCustomAvatarFile(profile);
    profile.avatar = null;
    touch(profile);
  });
  return getProfile(id);
}
