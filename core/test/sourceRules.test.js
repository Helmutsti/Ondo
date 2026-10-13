import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesOf, validateRules, nextCheckFrom, maxHeightFor, DEFAULT_RULES } from '../src/services/sourceRules.js';

test('le fonti di prima delle regole: controllo ogni 6 ore, niente scaricamento automatico', () => {
  assert.deepEqual(rulesOf({}), { ...DEFAULT_RULES });
  assert.equal(rulesOf({}).autoDownload, false);
});

test('"mai" resta mai, una frequenza sconosciuta torna al default', () => {
  assert.equal(rulesOf({ rules: { checkEvery: null } }).checkEvery, null);
  assert.equal(rulesOf({ rules: { checkEvery: '3h' } }).checkEvery, '6h');
});

test('validazione dall\'API', () => {
  assert.throws(() => validateRules({ checkEvery: '2h' }), /Frequenza non valida/);
  assert.deepEqual(validateRules({ autoDownload: 'sì' }), { autoDownload: false }, 'solo true accende');
  assert.deepEqual(validateRules({ quality: { kind: 'height', height: '1080' } }), { quality: { kind: 'height', height: 1080 } });
  assert.deepEqual(validateRules({ quality: { kind: 'boh' } }), { quality: null });
});

test('prossimo controllo e qualità del download', () => {
  assert.equal(nextCheckFrom({ checkEvery: '6h' }, '2026-10-13T00:00:00.000Z'), '2026-10-13T06:00:00.000Z');
  assert.equal(nextCheckFrom({ checkEvery: null }, '2026-10-13T00:00:00.000Z'), null);
  assert.equal(maxHeightFor({ quality: null }), undefined, 'predefinita');
  assert.equal(maxHeightFor({ quality: { kind: 'best' } }), null, 'massima');
  assert.equal(maxHeightFor({ quality: { kind: 'height', height: 720 } }), 720);
});
