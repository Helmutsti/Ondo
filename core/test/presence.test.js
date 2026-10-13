import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRemoteVerdict, needsPresenceCheck, MAX_CHECK_ATTEMPTS } from '../src/services/presenceService.js';
import { classifyYtdlpError } from '../src/ytdlp/errorClassifier.js';

const video = (extra = {}) => ({ id: 'abc', presence: 'present', removedAt: null, sources: [], ...extra });
const err = (line) => classifyYtdlpError(`yt-dlp terminato con codice 1: ERROR: [youtube] abc: ${line}`);
const hoursLater = (base, h) => new Date(base.getTime() + h * 3600 * 1000);

test('un limite di YouTube non tocca mai il video', () => {
  const v = video();
  const before = JSON.stringify(v);
  const r = applyRemoteVerdict(v, err('Video unavailable. This content isn’t available, try again later.'));
  assert.equal(r.outcome, 'stop');
  assert.equal(JSON.stringify(v), before);
});

test('privato → rimosso subito, con motivo', () => {
  const v = video();
  assert.equal(applyRemoteVerdict(v, err('Private video. Sign in if you\'ve been granted access')).outcome, 'removed');
  assert.equal(v.presence, 'removed');
  assert.equal(v.removedReason, 'private');
});

test('"Video unavailable" generico serve confermarlo a distanza di ore', () => {
  const t0 = new Date('2026-10-13T10:00:00Z');
  const v = video();
  assert.equal(applyRemoteVerdict(v, err('Video unavailable'), { now: t0 }).outcome, 'strike');
  assert.equal(v.presence, 'present');
  assert.equal(v.presenceCheckPending, true);
  // Subito dopo: non conta.
  assert.equal(applyRemoteVerdict(v, err('Video unavailable'), { now: hoursLater(t0, 1) }).outcome, 'strike');
  assert.equal(v.presence, 'present');
  // Sei ore dopo: confermato.
  assert.equal(applyRemoteVerdict(v, err('Video unavailable'), { now: hoursLater(t0, 7) }).outcome, 'removed');
  assert.equal(v.presence, 'removed');
  assert.equal(v.removedReason, 'unavailable');
});

test('una risposta buona azzera i "unavailable" e ripristina un rimosso', () => {
  const v = video({ presence: 'removed', removedAt: '2026-01-01T00:00:00Z', goneStrikes: 1 });
  assert.equal(applyRemoteVerdict(v, null).outcome, 'restored');
  assert.equal(v.presence, 'present');
  assert.equal(v.goneStrikes, 0);
  assert.equal(v.removedAt, null);
});

test('accesso limitato: il video esiste (anche se era segnato rimosso)', () => {
  const v = video({ presence: 'removed', removedAt: '2026-01-01T00:00:00Z' });
  assert.equal(applyRemoteVerdict(v, err('Sign in to confirm your age')).outcome, 'restricted');
  assert.equal(v.presence, 'present');
  assert.equal(v.access.reason, 'age');
});

test('rete e sconosciuti: presenza invariata, si smette dopo troppi tentativi', () => {
  const v = video({ presenceCheckPending: true });
  for (let i = 1; i <= MAX_CHECK_ATTEMPTS; i++) {
    assert.equal(applyRemoteVerdict(v, err('Unable to download webpage: The read operation timed out')).outcome, 'unchanged');
    assert.equal(v.presence, 'present');
  }
  assert.equal(v.presenceCheckPending, false);
  assert.equal(v.presenceCheckError.category, 'network');
});

test('durante un download un errore di rete non conta come controllo mancato', () => {
  const v = video({ presenceCheckPending: true });
  applyRemoteVerdict(v, err('Unable to download webpage: timed out'), { isCheck: false });
  assert.equal(v.presenceCheckAttempts, undefined);
  assert.equal(v.presenceCheckPending, true);
});

test('i "rimossi" della logica di prima vengono ricontrollati una volta', () => {
  assert.equal(needsPresenceCheck(video({ presence: 'removed' })), true);
  assert.equal(needsPresenceCheck(video({ presence: 'removed', removedReason: 'private' })), false);
  assert.equal(needsPresenceCheck(video({ presence: 'removed', presenceCheckedAt: '2026-10-13T10:00:00Z' })), false);
  assert.equal(needsPresenceCheck(video()), false);
});
