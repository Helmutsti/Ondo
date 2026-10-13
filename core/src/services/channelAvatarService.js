import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { listChannels, listVideosByChannel } from './videoService.js';
import { sanitizeName } from './libraryService.js';
import { resolveChannelAvatar } from '../ytdlp/ytdlpWrapper.js';

const EXT_BY_CONTENT_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Scarica l'immagine dell'avatar via fetch nativo (non un'altra chiamata
// yt-dlp: l'URL risolto è una semplice immagine HTTPS). Se il nome file
// cambia rispetto al precedente (es. estensione diversa su un refresh
// forzato), rimuove il vecchio file per non lasciare orfani in media/avatars/.
async function downloadAvatarImage(avatarUrl, avatarsDir, baseName, previousLocalPath) {
  const res = await fetch(avatarUrl);
  if (!res.ok) throw new Error(`Download foto profilo fallito: HTTP ${res.status}`);
  const contentType = res.headers.get('content-type')?.split(';')[0].trim();
  const ext = EXT_BY_CONTENT_TYPE[contentType] ?? 'jpg';
  const filename = `${baseName}.${ext}`;

  if (previousLocalPath && previousLocalPath !== filename) {
    const stale = path.join(avatarsDir, previousLocalPath);
    if (existsSync(stale)) unlinkSync(stale);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  // M98 — la cartella la crea `initLibrary`, quindi normalmente c'è già: questo
  // `mkdirSync` copre solo il caso in cui l'utente l'abbia cancellata a mano.
  // Da M98 non è più `getPaths()` a ricrearla, perché risolvere un percorso non
  // deve avere effetti collaterali sul disco.
  mkdirSync(avatarsDir, { recursive: true });
  await writeFile(path.join(avatarsDir, filename), buf);
  return filename;
}

// L'URL del canale da cui leggere la foto: dal primo video del canale che lo
// porta (channel.url/uploaderUrl arrivano con l'arricchimento), oppure, per i
// canali YouTube con id noto, costruito dall'id.
async function channelUrlFor(channelKey) {
  const videos = await listVideosByChannel(channelKey);
  for (const v of videos) {
    const url = v.channel?.url ?? v.channel?.uploaderUrl;
    if (url) return url;
  }
  if (/^UC[\w-]{22}$/.test(channelKey)) return `https://www.youtube.com/channel/${channelKey}`;
  return null;
}

/**
 * Scarica (o riscarica) la foto di UN canale da YouTube. Solo su richiesta:
 * dalla finestra "Foto del profilo" o dal comando esplicito della CLI. Non la
 * assegna a nessun profilo — quello è profileService.setProfileAvatar.
 * @returns il record salvato in channelAvatars
 */
export async function fetchChannelAvatar(channelKey) {
  const paths = getPaths();
  const catalog = await readCatalog();
  const existing = catalog.channelAvatars[channelKey];
  try {
    const channelUrl = await channelUrlFor(channelKey);
    if (!channelUrl) throw new Error('Indirizzo del canale non ancora noto: aggiorna i metadati di un suo video e riprova.');
    const { avatarUrl } = await resolveChannelAvatar(channelUrl);
    if (!avatarUrl) throw new Error('Nessuna foto trovata per questo canale: puoi caricare un\'immagine tua.');
    const filename = await downloadAvatarImage(avatarUrl, paths.avatarsDir, sanitizeName(channelKey, 'channel'), existing?.localPath);
    const record = { channelKey, sourceUrl: avatarUrl, localPath: filename, fetchedAt: new Date().toISOString(), error: null };
    await updateCatalog((cat) => { cat.channelAvatars[channelKey] = record; });
    return record;
  } catch (err) {
    await updateCatalog((cat) => {
      cat.channelAvatars[channelKey] = {
        channelKey,
        sourceUrl: existing?.sourceUrl ?? null,
        localPath: existing?.localPath ?? null,
        fetchedAt: existing?.fetchedAt ?? null,
        error: err.message
      };
    });
    throw err;
  }
}

// Scarica le foto di più canali (comando esplicito della CLI "foto creator").
// force:false salta i canali che ne hanno già una; force:true le riscarica.
// Un fallimento su un canale non interrompe gli altri. Niente più chiamate
// automatiche a fine sync: le foto si scelgono a mano, profilo per profilo.
export async function syncChannelAvatars({ force = false, channelKey = null } = {}) {
  const allChannels = await listChannels();
  const channels = channelKey ? allChannels.filter((c) => c.key === channelKey) : allChannels;
  if (channelKey && channels.length === 0) {
    throw new Error(`Creator non trovato: "${channelKey}"`);
  }

  let fetchedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors = [];

  for (const channel of channels) {
    const catalog = await readCatalog();
    const existing = catalog.channelAvatars[channel.key];
    if (!force && existing?.localPath && !existing.error) {
      skippedCount += 1;
      continue;
    }
    try {
      await fetchChannelAvatar(channel.key);
      fetchedCount += 1;
    } catch (err) {
      failedCount += 1;
      errors.push({ key: channel.key, name: channel.name, error: err.message });
    }
  }

  return { channelsConsidered: channels.length, fetchedCount, skippedCount, failedCount, errors };
}
