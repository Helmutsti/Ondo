import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureProfiles } from '../src/catalog/profiles.js';

// --- Modello puro

const vid = (id, channelId, name, extra = {}) => ({ id, channel: { id: channelId, name }, presence: 'present', download: 'none', sources: [], ...extra });

test('al primo avvio ogni canale diventa un profilo, con la foto che aveva', () => {
  const cat = {
    videos: { a: vid('a', 'UC1', 'Angelica'), b: vid('b', 'UC1', 'Angelica'), c: vid('c', 'UC2', 'Angelica\'s Grass') },
    channelAvatars: { UC1: { channelKey: 'UC1', localPath: 'UC1.jpg', fetchedAt: '2026-01-01' } }
  };
  assert.equal(ensureProfiles(cat), true);
  const profiles = Object.values(cat.profiles);
  assert.equal(profiles.length, 2);
  const p1 = profiles.find((p) => p.channelKeys[0] === 'UC1');
  assert.deepEqual(p1.avatar, { type: 'channel', channelKey: 'UC1' });
  assert.equal(profiles.find((p) => p.channelKeys[0] === 'UC2').avatar, null);
  assert.equal(ensureProfiles(cat), false, 'idempotente');
});

// --- Servizio, su una libreria vera in una cartella temporanea

let dir;
let core;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ondo-profili-'));
  const { initLibrary, setLibraryOverride } = await import('../src/library.js');
  initLibrary(dir);
  setLibraryOverride(dir);
  core = {
    ...(await import('../src/services/profileService.js')),
    ...(await import('../src/catalog/catalogStore.js'))
  };
  await core.updateCatalog((cat) => {
    cat.videos.a = vid('a', 'UC1', 'Angelica', { download: 'downloaded', video: { sizeBytes: 1000 } });
    cat.videos.b = vid('b', 'UC1', 'Angelica', { presence: 'removed', sources: [{ sourceId: 'PL1', name: 'Lista' }] });
    cat.videos.c = vid('c', 'UC2', 'Angelica\'s Grass', { sources: [{ sourceId: 'PL1', name: 'Lista' }] });
    cat.videos.d = vid('d', 'UC3', 'Altro');
    cat.channelAvatars.UC2 = { channelKey: 'UC2', localPath: 'UC2.jpg', fetchedAt: '2026-01-01' };
  });
});

after(async () => {
  const { closeDb } = await import('../src/catalog/db.js');
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const byChannel = async (key) => (await core.listProfiles()).find((p) => p.channels.some((c) => c.key === key));

test('i canali nuovi ricevono un profilo alla lettura, con le statistiche', async () => {
  const profiles = await core.listProfiles();
  assert.equal(profiles.length, 3);
  const angelica = await byChannel('UC1');
  assert.equal(angelica.name, 'Angelica');
  assert.equal(angelica.videoCount, 2);
  assert.equal(angelica.downloaded, 1);
  assert.equal(angelica.removed, 1);
  assert.equal(angelica.toDownload, 0);
  assert.equal(angelica.bytesOnDisk, 1000);
  assert.deepEqual(angelica.sources.map((s) => s.id), ['PL1']);
});

test('unire sposta il canale, elimina il profilo rimasto vuoto e ne eredita la foto', async () => {
  const angelica = await byChannel('UC1');
  const grassId = (await byChannel('UC2')).id;
  const merged = await core.mergeChannelsIntoProfile(angelica.id, ['UC2']);
  assert.deepEqual(merged.channels.map((c) => c.key), ['UC1', 'UC2']);
  assert.equal(merged.videoCount, 3);
  assert.equal(merged.avatarChannelKey, 'UC2');
  assert.equal((await core.listProfiles()).length, 2);
  await assert.rejects(core.getProfile(grassId), /Profilo non trovato/);
  assert.equal((await core.listProfileVideos(angelica.id)).length, 3);
  assert.equal(await core.getProfileIdForChannel('UC2'), angelica.id);
});

test('separare un canale ne fa di nuovo un profilo a sé', async () => {
  const angelica = await byChannel('UC1');
  const split = await core.splitChannelFromProfile(angelica.id, 'UC2');
  assert.deepEqual(split.channels.map((c) => c.key), ['UC2']);
  const after = await core.getProfile(angelica.id);
  assert.deepEqual(after.channels.map((c) => c.key), ['UC1']);
  assert.equal(after.avatar, null, 'la foto era del canale separato');
  await assert.rejects(core.splitChannelFromProfile(split.id, 'UC2'), /unico canale/);
});

test('rinomina, fissa, foto caricata e indice per i video', async () => {
  const angelica = await byChannel('UC1');
  assert.equal((await core.renameProfile(angelica.id, '  Angie  ')).name, 'Angie');
  assert.equal((await core.setProfilePinned(angelica.id, true)).pinned, true);
  await assert.rejects(core.setCustomPhoto(angelica.id, Buffer.from('x'), 'image/gif'), /Formato non supportato/);
  const withPhoto = await core.setCustomPhoto(angelica.id, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
  assert.equal(withPhoto.avatarType, 'custom');
  const file = path.join(dir, 'avatars', withPhoto.avatar.localPath);
  assert.ok(existsSync(file));
  const index = await core.getCreatorIndex();
  assert.equal(index.UC1.profileId, angelica.id);
  assert.equal(index.UC1.avatar.localPath, withPhoto.avatar.localPath);
  await core.clearProfilePhoto(angelica.id);
  assert.equal(existsSync(file), false, 'il file caricato si cancella');
  assert.equal((await core.renameProfile(angelica.id, '')).name, 'Angelica', 'nome vuoto = torna a seguire il canale');
  await assert.rejects(core.useChannelPhoto(angelica.id, 'UC1'), /non è ancora stata scaricata/);
});
