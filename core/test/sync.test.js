import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestPlaylistEntries, assessEnumeration, LEFT_SOURCE_MISS_THRESHOLD } from '../src/services/syncService.js';

const source = { id: 'PL1', name: 'ToDownload' };
const paths = { videosDir: '/nonexistent' };
const entry = (id, extra = {}) => ({ id, title: `Video ${id}`, channelName: 'Ch', durationSeconds: 10, playlistIndex: 1, unavailable: null, ...extra });
const existing = (id, extra = {}) => ({ id, title: `Video ${id}`, presence: 'present', download: 'none', sources: [{ sourceId: 'PL1', name: 'ToDownload' }], ...extra });

function catalogWith(...videos) {
  return { videos: Object.fromEntries(videos.map((v) => [v.id, v])) };
}

test('uscire dalla playlist NON rende un video sparito da YouTube', () => {
  const cat = catalogWith(existing('a'), existing('b'));
  for (let i = 0; i < LEFT_SOURCE_MISS_THRESHOLD + 3; i++) {
    ingestPlaylistEntries(cat, source, [entry('a')], paths);
  }
  const b = cat.videos.b;
  assert.equal(b.presence, 'present');
  assert.ok(b.sources[0].leftAt, 'uscito dalla fonte');
  assert.equal(b.presenceCheckPending, true, 'chiede un controllo del singolo video');
});

test('una sola assenza non basta per uscire dalla fonte', () => {
  const cat = catalogWith(existing('a'), existing('b'));
  const r = ingestPlaylistEntries(cat, source, [entry('a')], paths);
  assert.equal(r.leftCount, 0);
  assert.equal(cat.videos.b.sources[0].leftAt, undefined);
  assert.equal(cat.videos.b.sources[0].missCount, 1);
});

test('chi rientra nella playlist torna nella fonte', () => {
  const cat = catalogWith(existing('a', { sources: [{ sourceId: 'PL1', leftAt: '2026-01-01T00:00:00Z', missCount: 2 }] }));
  const r = ingestPlaylistEntries(cat, source, [entry('a')], paths);
  assert.equal(r.rejoinedCount, 1);
  assert.equal(cat.videos.a.sources[0].leftAt, null);
});

test('elenco sospetto: si aggiungono i nuovi ma non si deduce nulla dalle assenze', () => {
  const cat = catalogWith(existing('a'), existing('b'));
  for (let i = 0; i < 5; i++) {
    ingestPlaylistEntries(cat, source, [entry('n')], paths, { applyAbsence: false });
  }
  assert.ok(cat.videos.n, 'nuovo aggiunto');
  assert.equal(cat.videos.a.sources[0].missCount, undefined);
  assert.equal(cat.videos.b.presenceCheckPending, undefined);
});

test('le voci segnaposto non diventano video e chiedono un controllo', () => {
  const cat = catalogWith(existing('a'));
  const r = ingestPlaylistEntries(cat, source, [entry('a', { title: '[Deleted video]', unavailable: 'deleted' }), entry('x', { title: '[Private video]', unavailable: 'private' })], paths);
  assert.equal(cat.videos.x, undefined);
  assert.equal(r.placeholderCount, 2);
  assert.equal(cat.videos.a.presence, 'present');
  assert.equal(cat.videos.a.presenceCheckPending, true);
  assert.equal(cat.videos.a.title, 'Video a', 'il titolo vero non viene sovrascritto');
});

test('un rimosso che ricompare viene verificato, non ripristinato alla cieca', () => {
  const cat = catalogWith(existing('a', { presence: 'removed', removedAt: '2026-01-01T00:00:00Z' }));
  ingestPlaylistEntries(cat, source, [entry('a')], paths);
  assert.equal(cat.videos.a.presence, 'removed');
  assert.equal(cat.videos.a.presenceCheckPending, true);
});

test('validazione: elenco normale, calo forte, calo confermato, avvisi', () => {
  assert.deepEqual(assessEnumeration({ count: 150, lastGoodCount: 156 }), { ok: true, reason: null });
  assert.deepEqual(assessEnumeration({ count: 41, lastGoodCount: 156 }), { ok: false, reason: 'drop' });
  assert.deepEqual(assessEnumeration({ count: 0, lastGoodCount: 3 }), { ok: false, reason: 'drop' });
  assert.deepEqual(assessEnumeration({ count: 41, lastGoodCount: 156, suspect: { reason: 'drop', count: 41 } }), { ok: true, reason: 'confirmed-drop' });
  assert.deepEqual(assessEnumeration({ count: 41, lastGoodCount: 156, suspect: { reason: 'drop', count: 90 } }), { ok: false, reason: 'drop' });
  assert.deepEqual(assessEnumeration({ count: 156, lastGoodCount: 156, warnings: ['WARNING: [youtube:tab] Incomplete data received. Retrying (1/3)...'] }), { ok: false, reason: 'warnings' });
  assert.deepEqual(assessEnumeration({ count: 3, lastGoodCount: null }), { ok: true, reason: null });
});
