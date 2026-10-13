import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'ondo-blocco-'));
process.env.ONDO_CONFIG_DIR = dir;
const { getBlock, noteBlocked, noteUnblocked } = await import('../src/services/blockState.js');

test('attesa crescente: 15 min, poi 30, poi 60; un successo azzera', () => {
  const t0 = Date.parse('2026-10-13T12:00:00.000Z');
  const c = { category: 'blocked', hint: 'YouTube chiede di confermare che non sei un bot' };
  assert.equal(noteBlocked(c, t0).until, '2026-10-13T12:15:00.000Z');
  assert.equal(noteBlocked(c, t0).until, '2026-10-13T12:30:00.000Z');
  assert.equal(noteBlocked(c, t0).until, '2026-10-13T13:00:00.000Z');
  assert.ok(getBlock(t0), 'in pausa');
  assert.equal(getBlock(Date.parse('2026-10-13T13:00:01.000Z')), null, 'pausa finita');
  noteUnblocked();
  assert.equal(noteBlocked(c, t0).level, 1, 'dopo un successo si riparte da 15 minuti');
  noteUnblocked();
  rmSync(dir, { recursive: true, force: true });
});
