import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { impersonateArgs } from '../src/ytdlp/ytdlpWrapper.js';

// Un finto yt-dlp che stampa l'elenco dei target, con o senza curl_cffi.
function fakeYtdlp(output) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ondo-imp-'));
  const bin = path.join(dir, 'yt-dlp');
  writeFileSync(bin, `#!/bin/sh\ncat <<'EOT'\n${output}\nEOT\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

test('Rumble: imita Chrome se yt-dlp lo supporta, YouTube mai', () => {
  const { bin, dir } = fakeYtdlp('Client          OS           Source\nChrome-146      Macos-26     curl_cffi');
  assert.deepEqual(impersonateArgs('https://rumble.com/v2qt2il-x.html?e9s=a', bin), ['--impersonate', 'chrome']);
  assert.deepEqual(impersonateArgs('https://rumble.com/embed/v2o7n3p/', bin), ['--impersonate', 'chrome']);
  assert.deepEqual(impersonateArgs('https://www.youtube.com/watch?v=abc', bin), []);
  assert.deepEqual(impersonateArgs('non un url', bin), []);
  rmSync(dir, { recursive: true, force: true });
});

test('senza curl_cffi non si aggiunge niente (farebbe fallire anche ciò che va)', () => {
  const { bin, dir } = fakeYtdlp('Client          OS           Source\nChrome          -            curl_cffi (unavailable)');
  assert.deepEqual(impersonateArgs('https://rumble.com/embed/v2o7n3p/', bin), []);
  rmSync(dir, { recursive: true, force: true });
});
