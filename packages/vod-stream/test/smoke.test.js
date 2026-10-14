// Prova completa con ffmpeg vero: genera due video di prova (AV1 1080p60 +
// Opus in WebM, H.264 1080p60 + Opus in MKV — i formati più comuni scaricati
// da YouTube alla qualità massima) e li fa passare da vod-stream.
//
//   npm test        (serve ffmpeg con libx264 e un encoder AV1 nel PATH)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createVodStream } from '../src/server/index.js';

const work = mkdtempSync(path.join(os.tmpdir(), 'vod-stream-test-'));
const files = {
  av1: path.join(work, 'av1 [prova].webm'),
  h264: path.join(work, 'h264.mkv')
};
const SECONDS = 40;
let server;
let base;
let vod;

function makeSample(file, vcodec) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=60:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
    ...vcodec, '-c:a', 'libopus', '-b:a', '96k', file
  ]);
}

async function get(p) {
  const t0 = performance.now();
  const res = await fetch(base + p);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type'), body, ms: performance.now() - t0 };
}

function startTime(buf, name) {
  const f = path.join(work, name);
  execFileSync('sh', ['-c', `cat > "${f}"`], { input: buf });
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,codec_name,height', '-of', 'json', f]);
  return JSON.parse(out).streams;
}

before(() => {
  makeSample(files.av1, ['-c:v', 'libsvtav1', '-preset', '12', '-g', '240']);
  makeSample(files.h264, ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '240']);
  vod = createVodStream({
    resolveFile: async (id) => files[id] ?? null,
    cacheDir: path.join(work, 'cache'),
    log: (m) => process.env.VOD_DEBUG && console.log(m)
  });
  server = http.createServer((req, res) => {
    if (!req.url.startsWith('/stream/')) { res.statusCode = 404; return res.end(); }
    req.url = req.url.slice('/stream'.length);
    vod.handler(req, res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}/stream`;
    r();
  }));
});

after(() => {
  vod.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
});

test('info.json: tipo esatto del file e qualità fino alla sua risoluzione', async () => {
  const { status, body } = await get('/av1/info.json');
  assert.equal(status, 200);
  const info = JSON.parse(body);
  assert.equal(info.container, 'video/webm');
  assert.match(info.mimeType, /av01.*opus/);
  assert.equal(Math.round(info.duration), SECONDS);
  assert.deepEqual(info.renditions.map((r) => r.name), ['360p', '720p', '1080p']);
  assert.deepEqual(info.renditions[0], { name: '360p', width: 640, height: 360 });
  assert.equal(info.audioPlaylist, 'audio/index.m3u8');
});

test('master: varianti H.264/AAC, la prima è quella di partenza, fps limitati a 30', async () => {
  const { status, type, body } = await get('/av1/master.m3u8');
  assert.equal(status, 200);
  assert.equal(type, 'application/vnd.apple.mpegurl');
  const text = body.toString();
  assert.match(text, /CODECS="avc1\.640028,mp4a\.40\.2"/);
  assert.match(text, /FRAME-RATE=30\.000/);
  assert.equal(text.split('\n').find((l) => l.endsWith('.m3u8')), '360p/index.m3u8');
});

test('playlist VOD completa da subito: niente "in diretta"', async () => {
  const text = (await get('/av1/720p/index.m3u8')).body.toString();
  const { duration } = JSON.parse((await get('/av1/info.json')).body);
  assert.match(text, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(text, /#EXT-X-ENDLIST/);
  const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(durations.length, Math.ceil(duration / 4 - 1e-6));
  assert.ok(Math.abs(durations.reduce((a, b) => a + b, 0) - duration) < 0.01);
});

test('AV1 1080p60: il primo segmento a 360p arriva in fretta ed è H.264', async () => {
  const seg = await get('/av1/360p/0.ts');
  assert.equal(seg.status, 200);
  console.log(`   primo segmento 360p da AV1 1080p60: ${seg.ms.toFixed(0)} ms`);
  const streams = startTime(seg.body, 'a0.ts');
  assert.equal(streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
  assert.equal(streams.find((s) => s.codec_type === 'video').height, 360);
  assert.equal(streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
});

test('salto in avanti: si riparte da lì, timestamp sulla stessa griglia', async () => {
  const s0 = startTime((await get('/av1/360p/0.ts')).body, 'g0.ts');
  const jump = await get('/av1/360p/7.ts');
  assert.equal(jump.status, 200);
  console.log(`   salto al segmento 7: ${jump.ms.toFixed(0)} ms`);
  const s7 = startTime(jump.body, 'g7.ts');
  const v0 = Number(s0.find((s) => s.codec_type === 'video').start_time);
  const v7 = Number(s7.find((s) => s.codec_type === 'video').start_time);
  // Esattamente 7 segmenti da 4 s dopo (tolleranza: un millisecondo).
  assert.ok(Math.abs(v7 - v0 - 28) < 0.002, `start_time 0=${v0} 7=${v7}`);
});

test('segmento già prodotto: dalla cache, istantaneo', async () => {
  await get('/h264/720p/2.ts');
  const again = await get('/h264/720p/2.ts');
  assert.equal(again.status, 200);
  assert.ok(again.ms < 100, `${again.ms} ms`);
  assert.ok(existsSync(path.join(await vod.cachePath('h264'), '720p', '2.ts')));
});

test('ultimo segmento più corto e richieste fuori misura', async () => {
  const { duration } = JSON.parse((await get('/h264/info.json')).body);
  const count = Math.ceil(duration / 4 - 1e-6);
  const last = await get(`/h264/360p/${count - 1}.ts`);
  assert.equal(last.status, 200);
  assert.equal((await get(`/h264/360p/${count}.ts`)).status, 404);
  assert.equal((await get('/h264/4320p/0.ts')).status, 404);
  assert.equal((await get('/nessuno/info.json')).status, 404);
});

test('solo audio: AAC senza video, fuori dal master, sulla stessa griglia', async () => {
  assert.doesNotMatch((await get('/av1/master.m3u8')).body.toString(), /audio\//);
  const text = (await get('/av1/audio/index.m3u8')).body.toString();
  assert.match(text, /#EXT-X-PLAYLIST-TYPE:VOD/);
  const seg = await get('/av1/audio/0.ts');
  assert.equal(seg.status, 200);
  console.log(`   primo segmento solo audio: ${seg.ms.toFixed(0)} ms`);
  const s0 = startTime(seg.body, 'au0.ts');
  assert.deepEqual(s0.map((s) => s.codec_type), ['audio']);
  assert.equal(s0[0].codec_name, 'aac');
  const s5 = startTime((await get('/av1/audio/5.ts')).body, 'au5.ts');
  const d = Number(s5[0].start_time) - Number(s0[0].start_time);
  assert.ok(Math.abs(d - 20) < 0.05, `start_time 0=${s0[0].start_time} 5=${s5[0].start_time}`);
});
