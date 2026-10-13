import { randomUUID } from 'node:crypto';

// Profili creator: il "chi" sopra i canali. Una persona può avere più canali
// YouTube (principale, secondario, ricaricamenti): il profilo li raggruppa e
// porta nome e foto scelti dall'utente. Non è un'iscrizione: nel catalogo entra
// solo ciò che passa da una fonte o da un link diretto, e i video non cambiano —
// il profilo di un video si ricava dal suo canale.
//
// Forma (tabella `profiles`, una riga per profilo):
//   { id, name, renamed, channelKeys: [..], avatar, pinned, createdAt, updatedAt }
//   - name/renamed: finché l'utente non lo rinomina (renamed:false) il nome
//     mostrato segue quello attuale del primo canale; rinominato, resta fisso.
//   - avatar: null | { type: 'channel', channelKey } | { type: 'custom', localPath, updatedAt }
//     La foto di un canale vive in channelAvatars e si scarica solo su richiesta.
//   - un canale appartiene a UN solo profilo.
//
// Modulo puro sul catalogo in memoria (nessun I/O): lo usa catalogStore al
// caricamento, i servizi dentro updateCatalog.

// Stessa regola di videoService.channelKey (qui duplicata per non importare un
// servizio dal livello del catalogo).
export function videoChannelKey(video) {
  return video.channel?.id ?? video.channel?.name ?? null;
}

export function newProfileId() {
  return `p-${randomUUID().slice(0, 8)}`;
}

/** channelKey → profileId, per tutti i canali assegnati. */
export function channelToProfile(cat) {
  const map = new Map();
  for (const profile of Object.values(cat.profiles ?? {})) {
    for (const key of profile.channelKeys ?? []) map.set(key, profile.id);
  }
  return map;
}

/** I canali presenti nei video: channelKey → { key, name, count }. */
export function channelsInVideos(cat) {
  const channels = new Map();
  for (const video of Object.values(cat.videos ?? {})) {
    const key = videoChannelKey(video);
    if (!key) continue;
    let c = channels.get(key);
    if (!c) {
      c = { key, name: video.channel?.name ?? null, count: 0 };
      channels.set(key, c);
    }
    if (!c.name && video.channel?.name) c.name = video.channel.name;
    c.count += 1;
  }
  return channels;
}

export function createProfile(cat, { channelKey, name }) {
  const now = new Date().toISOString();
  const photo = cat.channelAvatars?.[channelKey];
  const profile = {
    id: newProfileId(),
    name: name ?? channelKey,
    renamed: false,
    channelKeys: [channelKey],
    // La foto già scaricata del canale (dalle versioni precedenti, o scaricata
    // a mano) diventa la foto del profilo. Altrimenti il profilo nasce senza.
    avatar: photo?.localPath ? { type: 'channel', channelKey } : null,
    pinned: false,
    createdAt: now,
    updatedAt: now
  };
  cat.profiles[profile.id] = profile;
  return profile;
}

/**
 * Dà un profilo a ogni canale che non ne ha uno. Idempotente.
 * @returns {boolean} true se ha creato qualcosa
 */
export function ensureProfiles(cat) {
  if (!cat.profiles) cat.profiles = {};
  const assigned = channelToProfile(cat);
  let changed = false;
  for (const channel of channelsInVideos(cat).values()) {
    if (assigned.has(channel.key)) continue;
    createProfile(cat, { channelKey: channel.key, name: channel.name });
    changed = true;
  }
  return changed;
}

/** true se qualche canale dei video non ha ancora un profilo (controllo senza scrivere). */
export function hasUnassignedChannels(cat) {
  const assigned = channelToProfile(cat);
  for (const video of Object.values(cat.videos ?? {})) {
    const key = videoChannelKey(video);
    if (key && !assigned.has(key)) return true;
  }
  return false;
}
