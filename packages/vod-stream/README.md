# vod-stream

Guardare un video su **qualunque dispositivo**, partendo **subito**, saltando **ovunque**, con la qualità che **sale da sola** fino al massimo.

- Se il browser sa leggere il file così com'è → riceve **il file originale** (massima qualità, nessun carico sul server).
- Se no (iPhone con MKV/AV1/VP9, browser vecchi…) → riceve uno stream **HLS adattivo** in H.264 + AAC che il server **converte al volo con ffmpeg**, a pezzi da 4 secondi, **solo i pezzi che servono**.

Niente dipendenze npm. Serve solo `ffmpeg` (con `libx264`) e `ffprobe`.

---

## Come funziona

```
browser                                   server (vod-stream)
───────                                   ───────────────────
GET <id>/info.json  ───────────────────▶  ffprobe: contenitore, codec, durata
     │                                    → { mimeType: 'video/webm; codecs="av01…, opus"', … }
     ▼
video.canPlayType(mimeType)?
     ├─ sì → <video src="file originale">         (fine: nessuna conversione)
     └─ no → GET <id>/master.m3u8  ──────▶  varianti 360p · 720p · 1080p (mai sopra il file)
              GET <id>/360p/index.m3u8 ──▶  playlist VOD COMPLETA, calcolata dalla durata
              GET <id>/360p/0.ts  ───────▶  segmento 0: in cache? subito.
                                              no? ffmpeg parte da lì e lo produce (~0,5 s)
              … l'ABR del player passa a 720p/1080p appena la rete regge …
              salto al minuto 40 ─────────▶  GET <id>/1080p/600.ts → ffmpeg riparte dal minuto 40
```

Le scelte che lo rendono veloce:

| | |
|---|---|
| **Playlist VOD completa da subito** | Il player conosce la durata vera e la barra copre tutto il video: niente "in diretta", salto in qualunque punto. |
| **Segmenti su richiesta** | Una conversione parte dal segmento chiesto, non dall'inizio del video. Un salto lontano la fa ripartire da lì. |
| **Prima la qualità leggera** | La prima variante del master (360p) si produce in mezzo secondo anche da un AV1 1080p60; poi il player sale. |
| **Fotogrammi chiave sulla griglia** | Ogni segmento dura esattamente `segmentSeconds` e ha timestamp assoluti: pezzi prodotti da conversioni diverse si incastrano senza scatti. |
| **Al massimo 30 fps e 1080p** (configurabile) | Dimezza il lavoro sui video a 60 fps; i 4K si guardano in 1080p. |
| **Cache** | Un segmento già prodotto si serve dal disco. Oltre `maxCacheBytes` si cancellano i video toccati meno di recente. |
| **Risparmio di CPU** | Una conversione troppo avanti rispetto a chi guarda viene sospesa (SIGSTOP) e ripresa quando serve; quelle senza richieste per `idleTimeoutMs` vengono chiuse; al massimo `maxJobs` insieme. |

---

## Installazione

Copia la cartella nel progetto (o usala come dipendenza git), poi:

```jsonc
// package.json del progetto
"dependencies": { "vod-stream": "file:./vod-stream" }
```

Requisiti: Node.js ≥ 18, `ffmpeg` e `ffprobe` nel PATH (o percorsi espliciti nelle opzioni). Il build di ffmpeg deve avere `libx264`; per leggere file AV1 serve `libdav1d` (presente nei build statici di BtbN e johnvansickle, e in Homebrew).

---

## Lato server

### Con Express

```js
import express from 'express';
import { createVodStream } from 'vod-stream';

const vod = createVodStream({
  // id (quello che userai negli URL) → percorso assoluto del file, o null se non esiste
  resolveFile: async (id) => db.videos.get(id)?.path ?? null,
  // dove tenere i segmenti convertiti: un disco LOCALE e veloce, non un NAS
  cacheDir: '/var/cache/vod-stream',
  log: console.log,
});

app.use('/stream', vod.handler);
// il file originale lo servi tu, con supporto Range (express.static lo fa già)
app.use('/files', express.static('/percorso/dei/video'));
```

### Con `http` di Node

```js
http.createServer((req, res) => {
  if (req.url.startsWith('/stream/')) {
    req.url = req.url.slice('/stream'.length); // l'handler vuole l'URL relativo al montaggio
    return vod.handler(req, res);
  }
  // …
});
```

### Rotte

Sotto il punto di montaggio, con `<id>` codificato con `encodeURIComponent`:

| Rotta | Contenuto |
|---|---|
| `GET <id>/info.json` | `{ duration, container, mimeType, videoCodec, audioCodec, width, height, fps, renditions[], masterPlaylist }` |
| `GET <id>/master.m3u8` | Playlist principale, una variante per qualità. La prima è quella di partenza. |
| `GET <id>/<qualità>/index.m3u8` | Playlist VOD completa di una qualità. |
| `GET <id>/<qualità>/<n>.ts` | Segmento `n` (MPEG-TS, H.264 + AAC), prodotto se non è in cache. |

### Opzioni

| Opzione | Predefinito | |
|---|---|---|
| `resolveFile(id)` | — obbligatoria | Percorso assoluto del file, o `null` → 404. |
| `cacheDir` | — obbligatoria | Cartella dei segmenti. Su disco locale. |
| `ffmpegPath`, `ffprobePath` | `'ffmpeg'`, `'ffprobe'` | |
| `segmentSeconds` | `4` | Durata di un segmento. Più corto = salti più rapidi, più richieste. |
| `renditions` | 360p · 720p · 1080p · 1440p · 2160p | `[{ name, height, videoBitrate, audioBitrate }]`. Si usano solo quelle ≤ risoluzione del file e ≤ `maxHeight`. |
| `maxHeight` | `1080` | Qualità massima prodotta. |
| `maxFps` | `30` | Sopra, si convertono a 30 fps. |
| `startRendition` | la prima (`'360p'`) | Variante di partenza (prima nel master). |
| `preset` | `'veryfast'` | Preset di x264. `superfast`/`ultrafast` se la CPU è poca. |
| `maxJobs` | `3` | Conversioni contemporanee. |
| `maxCacheBytes` | 2 GB | Oltre, si cancellano i video meno recenti. |
| `idleTimeoutMs` | `60000` | Una conversione senza richieste per questo tempo viene chiusa. |
| `maxAheadSeconds` | `90` | Oltre questo anticipo su chi guarda, la conversione si sospende. |
| `segmentTimeoutMs` | `45000` | Attesa massima di un segmento. |
| `cors` | `false` | `true` aggiunge `Access-Control-Allow-Origin: *`. |
| `log(msg)` | nessuno | Messaggi di diagnosi (conversioni avviate, chiuse, errori ffmpeg). |

Restituisce `{ handler, info(id), close(), cachePath(id) }`.

---

## Lato browser

```js
import { attachVideo, watchBuffering } from 'vod-stream/client';

const video = document.querySelector('video');

// Animazione di caricamento: true all'avvio, dopo un salto, quando la rete non tiene il passo.
const stopWatching = watchBuffering(video, (buffering) => spinner.hidden = !buffering);

const player = await attachVideo(video, {
  infoUrl: `/stream/${encodeURIComponent(id)}/info.json`,
  directUrl: `/files/${encodeURIComponent(fileName)}`,
  // hls.js serve solo dove HLS non è nativo (Chrome/Firefox/Android) E il file non è leggibile:
  // caricalo pigramente, così chi non ne ha bisogno non lo scarica.
  loadHls: () => import('hls.js').then((m) => m.default),
  onModeChange: (mode, url) => console.log(mode, url), // 'direct' | 'hls'
});

video.play();
// cambio video o smontaggio:
player.destroy();
```

| Opzione di `attachVideo` | |
|---|---|
| `infoUrl` | URL di `<id>/info.json`. |
| `directUrl` | URL del file originale (senza: sempre HLS). |
| `loadHls()` | Restituisce la classe `Hls` di hls.js (`npm i hls.js`). Senza, dove HLS non è nativo si usa il file. |
| `preferHls` | `true` = HLS anche se il file sarebbe leggibile (utile per provare). |
| `startTime` | Secondi da cui partire. |
| `hlsConfig` | Opzioni in più per hls.js. |
| `onModeChange(mode, url)` | Avvisa quale sorgente è in uso. |

La scelta:

1. **MKV su Safari/iPhone → HLS.** Safari non apre gli MKV, qualunque codec contengano.
2. **MKV altrove → file.** Chrome e Firefox li leggono (anche se `canPlayType` dice di no).
3. **Il resto → `video.canPlayType(mimeType)`** con il tipo completo, codec compresi.
4. **Ripiego:** se il file dà errore in riproduzione, si passa a HLS dal punto in cui si era.

HLS nativo (Safari, iPhone, iPad) non ha bisogno di hls.js.

---

## Provarlo

```bash
npm test                              # prova completa con ffmpeg vero (genera video AV1 e H.264 di prova)
node example/server.js ~/Video        # pagina di prova su http://localhost:8090, anche dall'iPhone
```

Nell'esempio la casella **forza HLS** obbliga la conversione anche su un browser che leggerebbe il file.

Misure su un Mac Apple Silicon (4 core usati da ffmpeg), sorgente **AV1 1080p60**:

| | |
|---|---|
| primo segmento 360p | ~0,6 s |
| avvio nel player (info + playlist + primo segmento) | ~1,6 s |
| salto in un punto non ancora convertito | ~0,5 s |
| segmento in cache | < 10 ms |

---

## Limiti

- **Audio:** si converte sempre in AAC stereo; il multicanale diventa stereo. Si usa la prima traccia audio, niente sottotitoli.
- **HDR:** i file HDR/10 bit diventano SDR 8 bit senza tone mapping (colori più spenti).
- **Senza B-frame:** necessari perché i segmenti di conversioni diverse abbiano timestamp coerenti. Il bitrate sale un po', in cambio la codifica è più veloce.
- **Una sola macchina:** sessioni e cache sono in memoria e su disco locale. Con più istanze dietro un bilanciatore serve un'affinità per video.
- **Sicurezza:** `resolveFile` decide quali file sono raggiungibili. Non passare mai l'`id` dritto a un percorso senza controllarlo (vedi l'esempio: `path.basename`).
- **SIGSTOP/SIGCONT:** su Windows la sospensione delle conversioni non c'è; resta la chiusura per inattività.

## Diagnosi

Passa `log: console.log`: vedrai ogni conversione avviata (`dal segmento N`), riavviata per un salto, sospesa, chiusa, e l'errore di ffmpeg se ne esce male (codec non supportato, file rovinato). L'errore arriva anche come risposta 500 al segmento richiesto.
