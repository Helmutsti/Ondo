// Esempio minimo: node example/server.js /cartella/con/i/video
// Poi apri http://localhost:8090 (anche dall'iPhone, con l'IP del computer).
//
// Ogni file della cartella è un video, con id = nome del file.

import http from 'node:http';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVodStream } from '../src/server/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const videosDir = path.resolve(process.argv[2] ?? '.');
const port = Number(process.env.PORT ?? 8090);

const vod = createVodStream({
  resolveFile: async (id) => {
    const file = path.join(videosDir, path.basename(id));
    return file.startsWith(videosDir) ? file : null;
  },
  cacheDir: path.join(os.tmpdir(), 'vod-stream-example'),
  log: console.log
});

// Il file originale, con supporto Range (serve al <video> per saltare).
function serveFile(req, res, file) {
  const { size } = statSync(file);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (!range) {
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return createReadStream(file).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : size - Number(range[2]);
  const end = range[1] && range[2] ? Number(range[2]) : size - 1;
  res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
  createReadStream(file, { start, end }).pipe(res);
}

http.createServer((req, res) => {
  const url = decodeURI(req.url.split('?')[0]);
  if (url.startsWith('/stream/')) {
    req.url = req.url.slice('/stream'.length);
    return vod.handler(req, res);
  }
  if (url.startsWith('/files/')) {
    const file = path.join(videosDir, path.basename(url));
    try { return serveFile(req, res, file); } catch { res.statusCode = 404; return res.end(); }
  }
  if (url === '/client.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return createReadStream(path.join(here, '../src/client/index.js')).pipe(res);
  }
  if (url === '/videos.json') {
    const list = readdirSync(videosDir).filter((f) => /\.(mp4|mkv|webm|mov|m4v|ts)$/i.test(f));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  createReadStream(path.join(here, 'index.html')).pipe(res);
}).listen(port, () => console.log(`vod-stream esempio: http://localhost:${port} — video da ${videosDir}`));
