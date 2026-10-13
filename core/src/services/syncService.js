import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { createNewVideoStub, DOWNLOAD_STATE, PRESENCE } from '../catalog/catalogSchema.js';
import { listEntries } from '../sourceProviders/playlistProvider.js';
import { removeFromDownloadArchive } from './libraryService.js';

export function extractPlaylistId(url) {
  try {
    return new URL(url).searchParams.get('list');
  } catch {
    return null;
  }
}

// Controlli consecutivi in cui un video deve mancare dalla playlist prima di
// considerarlo USCITO dalla fonte: un elenco può perdere un video per un
// controllo per un capriccio di YouTube.
export const LEFT_SOURCE_MISS_THRESHOLD = 2;

// Un elenco con meno del 90% dei video dell'ultimo elenco buono è sospetto.
const DROP_TOLERANCE = 0.9;
// Sotto questa dimensione un calo percentuale non significa niente.
const MIN_COUNT_FOR_DROP_CHECK = 5;
// Avvisi di yt-dlp che dicono che l'elenco può essere incompleto.
const INCOMPLETE_WARNING = /incomplete|truncat|unable to download (?:api |web)?page/i;

/**
 * Decide se un elenco appena letto si può usare per dedurre le uscite dalla
 * fonte. Un elenco sospetto si usa solo per AGGIUNGERE i video nuovi.
 *
 * Un calo forte viene accettato quando si ripete uguale al controllo dopo:
 * è il caso di chi svuota davvero una playlist (es. "ToDownload").
 *
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function assessEnumeration({ count, warnings = [], lastGoodCount = null, suspect = null }) {
  if (warnings.some((w) => INCOMPLETE_WARNING.test(w))) {
    return { ok: false, reason: 'warnings' };
  }
  const isDrop = lastGoodCount != null && lastGoodCount > 0 && (
    count === 0 || (lastGoodCount >= MIN_COUNT_FOR_DROP_CHECK && count < lastGoodCount * DROP_TOLERANCE)
  );
  if (!isDrop) return { ok: true, reason: null };
  const sameAsBefore = suspect?.reason === 'drop' && Math.abs((suspect.count ?? -1) - count) <= Math.max(2, Math.round(count * 0.02));
  if (sameAsBefore) return { ok: true, reason: 'confirmed-drop' };
  return { ok: false, reason: 'drop' };
}

// Il collegamento video→fonte, creato se manca. `changed` dice se il video va
// riscritto: una sync non deve riscrivere centinaia di schede identiche.
function sourceLink(video, sourceMeta) {
  let link = video.sources.find((s) => s.sourceId === sourceMeta.id);
  if (!link) {
    // Riuso in questa fonte (M41): un video già a catalogo (arrivato da
    // un'altra fonte, o singolo) trovato anche qui porta la sua etichetta.
    link = { sourceId: sourceMeta.id, name: sourceMeta.name ?? null };
    video.sources.push(link);
    return { link, changed: true };
  }
  return { link, changed: false };
}

// Trasforma l'elenco di una playlist in modifiche al catalogo:
//  - video nuovi → aggiunti (le voci segnaposto "[Private video]" /
//    "[Deleted video]" no: non hanno un titolo vero);
//  - auto-guarigione dei "downloaded" il cui file è sparito (→ none);
//  - video che mancano dall'elenco per LEFT_SOURCE_MISS_THRESHOLD controlli di
//    fila → USCITI dalla fonte (link.leftAt). Uscire da una playlist NON vuol
//    dire sparire da YouTube: lo hai tolto tu, o l'ha tolto l'autore. Si chiede
//    solo un controllo del singolo video (presenceCheckPending), ed è quel
//    controllo — non la playlist — a poter cambiare la presenza;
//  - video segnato rimosso che ricompare, o voce segnaposto → stesso controllo.
//
// `applyAbsence: false` quando l'elenco è sospetto: si aggiungono i nuovi ma non
// si deduce nulla dalle assenze.
//
// Usata sia da syncSource sia da sourceService.addSource (primo ingest: nessun
// video preesistente della fonte, quindi le assenze lì non contano).
export function ingestPlaylistEntries(catalog, sourceMeta, entries, paths, { applyAbsence = true } = {}) {
  let newCount = 0;
  // Gli id appena entrati: servono allo scaricamento automatico della fonte,
  // che deve toccare SOLO i video arrivati con questo controllo.
  const newIds = [];
  let healedCount = 0;
  let leftCount = 0;
  let rejoinedCount = 0;
  let toVerifyCount = 0;
  let placeholderCount = 0;
  const now = () => new Date().toISOString();
  const foundIds = new Set(entries.map((e) => e.id));

  const requestCheck = (video) => {
    if (!video.presenceCheckPending) toVerifyCount += 1;
    video.presenceCheckPending = true;
    video.updatedAt = now();
  };

  // «Ignorati per sempre»: la playlist può ancora elencarli, ma non rientrano.
  const ignored = new Set((catalog.ignored ?? []).map((x) => x.id));
  let ignoredCount = 0;

  for (const entry of entries) {
    const existing = catalog.videos[entry.id];
    if (!existing && ignored.has(entry.id)) {
      ignoredCount += 1;
      continue;
    }

    if (!existing) {
      if (entry.unavailable) {
        placeholderCount += 1;
        continue;
      }
      catalog.videos[entry.id] = createNewVideoStub({
        id: entry.id,
        title: entry.title,
        channelName: entry.channelName,
        durationSeconds: entry.durationSeconds,
        playlistIndex: entry.playlistIndex,
        playlistId: sourceMeta.id,
        playlistTitle: sourceMeta.name,
        sourceId: sourceMeta.id
      });
      newCount += 1;
      newIds.push(entry.id);
      continue;
    }

    if (!Array.isArray(existing.sources)) existing.sources = [];
    const { link, changed } = sourceLink(existing, sourceMeta);
    let touched = changed;
    if (link.missCount) {
      link.missCount = 0;
      touched = true;
    }
    if (link.leftAt) {
      link.leftAt = null;
      rejoinedCount += 1;
      touched = true;
    }

    if (entry.unavailable) {
      // YouTube mostra solo un segnaposto: probabile privato/cancellato, ma
      // è il controllo del singolo video a deciderlo.
      placeholderCount += 1;
      if (existing.presence === PRESENCE.PRESENT) requestCheck(existing);
    } else if (existing.presence === PRESENCE.REMOVED) {
      // Ricompare con un titolo vero: probabilmente è tornato. Si verifica
      // invece di ripristinare alla cieca.
      requestCheck(existing);
    }

    if (existing.download === DOWNLOAD_STATE.DOWNLOADED) {
      const filePath = existing.video?.localPath ? path.join(paths.videosDir, existing.video.localPath) : null;
      if (!filePath || !existsSync(filePath)) {
        // File sparito dal disco: torna scaricabile (auto-guarigione). Va
        // tolto anche dall'archivio yt-dlp (stesso bug di deleteVideoFile —
        // altrimenti il prossimo download viene saltato "già fatto" senza
        // scrivere nulla).
        existing.download = DOWNLOAD_STATE.NONE;
        healedCount += 1;
        touched = true;
        removeFromDownloadArchive(paths, existing.id);
      }
    }
    if (touched) existing.updatedAt = now();
    // altri stati di download (none/downloading/failed) e il flag hidden:
    // lasciati invariati dalla sync
  }

  if (applyAbsence) {
    for (const video of Object.values(catalog.videos)) {
      if (foundIds.has(video.id)) continue;
      const link = video.sources?.find((s) => s.sourceId === sourceMeta.id);
      if (!link || link.leftAt) continue;
      link.missCount = (link.missCount ?? 0) + 1;
      video.updatedAt = now();
      if (link.missCount >= LEFT_SOURCE_MISS_THRESHOLD) {
        link.leftAt = now();
        leftCount += 1;
        if (video.presence === PRESENCE.PRESENT) requestCheck(video);
      }
    }
  }

  return { newCount, newIds, healedCount, leftCount, rejoinedCount, toVerifyCount, placeholderCount, ignoredCount };
}

// Copertura dell'enumerazione (backlog #4): confronta i video realmente
// enumerati col totale dichiarato da YouTube. `missingCount > 0` = alcuni video
// della playlist non erano visibili in questa estrazione (privati/rimossi/glitch
// temporaneo). Il conteggio non è infallibile (a volte i privati compaiono come
// entry-segnaposto), quindi va presentato come indizio, non come verità assoluta.
export function playlistCoverage(declaredCount, enumeratedCount) {
  return {
    declaredCount: declaredCount ?? null,
    enumeratedCount,
    missingCount: declaredCount != null ? Math.max(0, declaredCount - enumeratedCount) : 0
  };
}

export async function syncSource(sourceId) {
  const catalog = await readCatalog();
  const sourceMeta = catalog.sources[sourceId];
  if (!sourceMeta) {
    throw new Error(`Fonte non trovata: "${sourceId}" — aggiungila prima da "Gestisci fonti"`);
  }

  const { entries, declaredCount, warnings = [] } = await listEntries(sourceMeta);
  const paths = getPaths();

  let result;
  await updateCatalog((cat) => {
    const meta = cat.sources[sourceId];
    if (!meta) throw new Error(`Fonte rimossa durante la sincronizzazione: "${sourceId}"`);
    const assessment = assessEnumeration({
      count: entries.length,
      warnings,
      lastGoodCount: meta.lastGoodCount ?? null,
      suspect: meta.suspect ?? null
    });
    result = ingestPlaylistEntries(cat, meta, entries, paths, { applyAbsence: assessment.ok });
    const nowIso = new Date().toISOString();
    meta.lastCheckedAt = nowIso;
    meta.lastWarnings = warnings.slice(-5);
    if (assessment.ok) {
      meta.lastGoodCount = entries.length;
      meta.suspect = null;
    } else {
      meta.suspect = { reason: assessment.reason, count: entries.length, lastGoodCount: meta.lastGoodCount ?? null, at: nowIso };
    }
    result.suspect = meta.suspect;
  });

  return { ...result, ...playlistCoverage(declaredCount, entries.length) };
}
