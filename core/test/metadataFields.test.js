import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeVideoFields } from '../src/services/metadataFields.js';

const video = (extra = {}) => ({ title: 'Vecchio titolo', description: 'Descrizione', tags: ['a', 'b'], thumbnail: { localPath: 'x.jpg', sha256: 'aaa' }, locks: [], ...extra });

test('le tre regole: riempi solo i vuoti, sovrascrivi, chiedimi', () => {
  const m = mergeVideoFields(video(), { title: 'Nuovo', description: 'Altra', tags: ['c'] }, {
    fields: ['title', 'description', 'tags'], rules: { title: 'ask', description: 'fill', tags: 'overwrite' }
  });
  assert.deepEqual(Object.keys(m.review), ['title']);
  assert.deepEqual(m.review.title, { current: 'Vecchio titolo', incoming: 'Nuovo' });
  assert.deepEqual(m.unchanged, ['description'], 'riempi solo i vuoti: la descrizione c\'era');
  assert.deepEqual(m.apply.tags, { from: ['a', 'b'], to: ['c'] });
});

test('un campo vuoto si riempie con qualunque regola', () => {
  const m = mergeVideoFields(video({ description: null }), { description: 'Nuova' }, { fields: ['description'], rules: { description: 'ask' } });
  assert.deepEqual(m.apply.description, { from: null, to: 'Nuova' });
});

test('garanzia: mai un vuoto o un segnaposto al posto di un valore', () => {
  const m = mergeVideoFields(video(), { title: 'Private video', description: '', tags: [] }, {
    fields: ['title', 'description', 'tags'], rules: { title: 'overwrite', description: 'overwrite', tags: 'overwrite' }
  });
  assert.deepEqual(Object.keys(m.apply), []);
  assert.deepEqual(m.protected.sort(), ['description', 'tags', 'title']);
  // …ma un segnaposto salvato si sostituisce con il valore vero
  const fixed = mergeVideoFields(video({ title: '[Private video]' }), { title: 'Titolo vero' }, { fields: ['title'], rules: { title: 'fill' } });
  assert.equal(fixed.apply.title.to, 'Titolo vero');
});

test('i campi bloccati non si toccano mai', () => {
  const m = mergeVideoFields(video({ locks: ['title'] }), { title: 'Nuovo' }, { fields: ['title'], rules: { title: 'overwrite' } });
  assert.deepEqual(m.locked, ['title']);
  assert.deepEqual(m.apply, {});
});

test('copertine: uguali se l\'immagine è la stessa, non se il nome coincide', () => {
  const same = mergeVideoFields(video(), { thumbnail: { file: '/tmp/x.jpg', sha: 'aaa' } }, { fields: ['thumbnail'], rules: { thumbnail: 'overwrite' } });
  assert.deepEqual(same.unchanged, ['thumbnail']);
  const diff = mergeVideoFields(video(), { thumbnail: { file: '/tmp/x.jpg', sha: 'bbb' } }, { fields: ['thumbnail'], rules: { thumbnail: 'ask' } });
  assert.ok(diff.review.thumbnail);
});

test('i campi non scelti si ignorano anche se diversi', () => {
  const m = mergeVideoFields(video(), { title: 'Nuovo', tags: ['z'] }, { fields: ['tags'], rules: { tags: 'overwrite' } });
  assert.equal(m.review.title, undefined);
  assert.equal(m.apply.title, undefined);
});

test('copertine: la stessa immagine riconvertita (byte diversi, aspetto uguale) non va in revisione', async () => {
  const { sameLook } = await import('../src/services/metadataFields.js');
  const a = Buffer.alloc(256, 120);
  const b = Buffer.from(a); b[0] = 130; b[1] = 110;
  const c = Buffer.alloc(256, 30);
  assert.equal(sameLook(a.toString('base64'), b.toString('base64')), true);
  assert.equal(sameLook(a.toString('base64'), c.toString('base64')), false);
  const m = mergeVideoFields(video(), { thumbnail: { file: '/tmp/n.jpg', sha: 'zzz', look: b.toString('base64') } }, {
    fields: ['thumbnail'], rules: { thumbnail: 'ask' }, currentThumbnail: { file: 'x.jpg', sha: 'aaa', look: a.toString('base64') }
  });
  assert.deepEqual(m.unchanged, ['thumbnail']);
});
