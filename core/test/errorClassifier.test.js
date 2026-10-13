import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyYtdlpError, ERROR_CATEGORY as C, isDefinitivelyGone, shouldStopRun } from '../src/ytdlp/errorClassifier.js';

// Ogni caso è un messaggio come arriva da runYtdlp/resolveVideoInfo:
// "yt-dlp terminato con codice 1: <coda di stderr>".
const wrap = (line) => `yt-dlp terminato con codice 1: WARNING: something\n${line}`;

const CASES = [
  // Il caso che prima segnava video esistenti come rimossi.
  ['ERROR: [youtube] abc: Video unavailable. This content isn’t available, try again later.', C.BLOCKED],
  ['ERROR: [youtube] abc: Video unavailable. This content isn\'t available, try again later.', C.BLOCKED],
  ['ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.', C.BLOCKED],
  ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', C.BLOCKED],
  ['ERROR: [youtube] abc: Video unavailable. The uploader has not made this video available in your country', C.RESTRICTED],
  ['ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', C.RESTRICTED],
  ['ERROR: [youtube] abc: Join this channel to get access to members-only content like this video, and other exclusive perks.', C.RESTRICTED],
  ['ERROR: [youtube] abc: Premieres in 3 hours', C.RESTRICTED],
  ['ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video', C.PRIVATE],
  // Le tre varianti reali citate nel codice di prima.
  ['ERROR: [youtube] abc: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.', C.REMOVED],
  ['ERROR: [youtube] abc: Video unavailable. It was removed following a copyright removal request by Someone', C.REMOVED],
  ['ERROR: [youtube] abc: This video has been removed by the uploader', C.REMOVED],
  ['ERROR: [youtube] abc: Video unavailable. This video has been removed for violating YouTube\'s Terms of Service', C.REMOVED],
  // Solo "Video unavailable": ambiguo, non definitivo.
  ['ERROR: [youtube] abc: Video unavailable', C.UNAVAILABLE],
  ['ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats', C.FORMAT],
  // Dal catalogo vero: 403 su Rumble.
  ['ERROR: [RumbleEmbed] v2o7iex: Unable to download JSON metadata: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)', C.FORMAT],
  ['ERROR: Postprocessing: ffmpeg exited with code 1', C.FORMAT],
  ['ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>', C.NETWORK],
  ['ERROR: Unable to download webpage: The read operation timed out', C.NETWORK],
  ['ERROR: Unable to download webpage: HTTP Error 503: Service Unavailable', C.NETWORK],
  ['ERROR: [youtube] abc: nsig extraction failed: Some formats may be missing', C.ENVIRONMENT],
  ['ERROR: [Errno 28] No space left on device', C.ENVIRONMENT],
  ['ERROR: [youtube] abc: Something unexpected happened; please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U', C.ENVIRONMENT],
  ['ERROR: [youtube] abc: some brand new message nobody has seen', C.UNKNOWN],
  // Risposte reali di yt-dlp 2026.08.19 sui video che il catalogo segnava rimossi.
  ['ERROR: [youtube] P7XlBqouVEg: Private video', C.PRIVATE],
  ['ERROR: [youtube] sJWHvrrXQxo: Video unavailable', C.UNAVAILABLE]
];

for (const [line, expected] of CASES) {
  test(`${expected} ← ${line.slice(0, 80)}`, () => {
    assert.equal(classifyYtdlpError(new Error(wrap(line))).category, expected);
  });
}

// Dal server (v2.7.1): un avviso sulle firme prima di "Private video" fermava
// tutta la verifica come se yt-dlp fosse da aggiornare.
test('la risposta nella riga ERROR vince sugli avvisi di contorno', () => {
  const stderr = [
    'yt-dlp terminato con codice 1: WARNING: [youtube] ys9abkJ2Zas: n challenge solving failed: Some formats may be missing. Please update yt-dlp',
    'WARNING: [youtube] No supported JavaScript runtime could be found.',
    'ERROR: [youtube] ys9abkJ2Zas: Private video'
  ].join('\n');
  assert.equal(classifyYtdlpError(new Error(stderr)).category, C.PRIVATE);
});
test('senza un esito sul video, l\'avviso di ambiente resta la causa', () => {
  const stderr = 'WARNING: [youtube] abc: nsig extraction failed: Some formats may be missing\nERROR: [youtube] abc: Requested format is not available';
  assert.equal(classifyYtdlpError(new Error(stderr)).category, C.ENVIRONMENT);
});

// Errori nostri, trovati nel catalogo vero.
test('internal: info.json illeggibile', () => {
  assert.equal(classifyYtdlpError('Unexpected token \'\x00\', "\x00\x05\x16" is not valid JSON').category, C.INTERNAL);
});
test('internal: file sparito', () => {
  assert.equal(classifyYtdlpError("ENOENT: no such file or directory, unlink '/app/videos/x.info.json'").category, C.INTERNAL);
});

test('solo rimosso e privato sono definitivi', () => {
  for (const c of Object.values(C)) {
    const def = isDefinitivelyGone({ category: c });
    assert.equal(def, c === C.REMOVED || c === C.PRIVATE, c);
  }
});

test('blocchi e ambiente fermano l\'esecuzione', () => {
  assert.equal(shouldStopRun({ category: C.BLOCKED }), true);
  assert.equal(shouldStopRun({ category: C.ENVIRONMENT }), true);
  assert.equal(shouldStopRun({ category: C.UNAVAILABLE }), false);
  assert.equal(shouldStopRun({ category: C.NETWORK }), false);
});

test('il messaggio mostrato è la riga ERROR, non tutta la coda di stderr', () => {
  const c = classifyYtdlpError(wrap('ERROR: [youtube] abc: Video unavailable'));
  assert.equal(c.message, 'ERROR: [youtube] abc: Video unavailable');
});
