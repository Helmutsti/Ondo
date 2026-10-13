import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { getPaths, getVideo, expectedToolNames, scratchRoot } from '@catalog/core';
import { createVodStream } from 'vod-stream';

// I binari di ffmpeg/ffprobe con la stessa precedenza del resto del core:
// quelli in tools/ (o nell'immagine Docker), altrimenti il PATH.
function tool(name) {
  const { ffmpegLocation } = getPaths();
  const bin = expectedToolNames()[name];
  if (ffmpegLocation) {
    const candidate = path.join(ffmpegLocation, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

// express.static (pacchetto "send" sotto il cofano) supporta già Range
// requests/ETag out of the box — necessario per il seek nel player <video>.
export function mountMediaRoutes(app) {
  const paths = getPaths();
  app.use('/media/videos', express.static(paths.videosDir));
  app.use('/media/thumbnails', express.static(paths.thumbnailsDir));
  app.use('/media/avatars', express.static(paths.avatarsDir));

  // Riproduzione su qualunque dispositivo (packages/vod-stream): il browser
  // chiede /media/stream/<id>/info.json e usa il file qui sopra se sa leggerlo,
  // altrimenti l'HLS adattivo convertito al volo da qui. I segmenti vanno
  // nell'area di lavoro locale (svuotata a ogni avvio), mai sul NAS.
  const vod = createVodStream({
    resolveFile: async (id) => {
      try {
        const video = await getVideo(id);
        return video.video?.localPath ? path.join(getPaths().videosDir, video.video.localPath) : null;
      } catch {
        return null;
      }
    },
    cacheDir: path.join(scratchRoot() ?? path.join(os.tmpdir(), 'ondo'), 'stream'),
    ffmpegPath: tool('ffmpeg'),
    ffprobePath: tool('ffprobe'),
    log: (m) => console.log(m)
  });
  app.use('/media/stream', vod.handler);
}
