import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Rss } from 'lucide-react';
import { searchVideos, setHidden, setFavorite, refreshMetadata, triggerJob, listProfiles, listSources } from '../api/client.js';
import { ProfileAvatar } from '../components/ProfileAvatar.jsx';
import { SkeletonRows } from '../components/Skeletons.jsx';
import { VideoCard } from '../components/VideoCard.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { startDownload } from '../lib/downloadActions.js';
import { showToast } from '../lib/toast.js';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [sources, setSources] = useState([]);
  useEffect(() => {
    listProfiles().then(setProfiles).catch(() => {});
    listSources().then(setSources).catch(() => {});
  }, []);

  // Anche creator (per nome del profilo o di uno dei suoi canali) e fonti:
  // la barra in alto cerca "video, creator, fonti".
  const norm = (x) => (x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const nq = norm(q.trim());
  const creatorHits = useMemo(() => (nq ? profiles.filter((p) => norm(p.name).includes(nq) || p.channels.some((c) => norm(c.name).includes(nq))).slice(0, 8) : []), [profiles, nq]);
  const sourceHits = useMemo(() => (nq ? sources.filter((src) => norm(src.name).includes(nq)).slice(0, 6) : []), [sources, nq]);

  useTitle(q.trim() ? `Cerca: ${q.trim()}` : 'Cerca');

  // Ricerca fuzzy multi-campo (M7): stesso motore usato dal CLI. La query
  // arriva dall'URL (`?q=`), impostata dall'unica barra in topbar (punto 10).
  useEffect(() => {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    let cancelled = false;
    searchVideos(trimmed)
      .then((r) => !cancelled && setResults(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [q]);

  async function reSearch() {
    const r = await searchVideos(q.trim());
    setResults(r);
  }

  // Copre tutte le azioni del menu ⋮ (M53), non più solo download/occhio: lo
  // stesso ventaglio di CatalogPage, qui instradato sui risultati di ricerca.
  async function handleAction(id, kind) {
    try {
      if (kind === 'download') {
        const title = (results ?? []).find((v) => v.id === id)?.title;
        await startDownload(id, { triggerJob, onSettled: reSearch, title });
        return;
      }
      if (kind === 'metadata') {
        await refreshMetadata(id);
        await reSearch();
        return;
      }
      if (kind === 'favorite' || kind === 'unfavorite') {
        await setFavorite(id, kind === 'favorite');
        await reSearch();
        return;
      }
      if (kind === 'hide' || kind === 'unhide') await setHidden(id, kind === 'hide');
      await reSearch();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="page-head"><h1>Cerca</h1></div>
      {error && <div className="notice error">{error}</div>}
      {!q.trim() ? (
        <div className="empty-state">Scrivi qualcosa per cercare nel catalogo.</div>
      ) : results === null ? (
        <SkeletonRows />
      ) : results.length === 0 && !creatorHits.length && !sourceHits.length ? (
        <div className="empty-state">Nessun risultato per "{q}".</div>
      ) : (
        <>
        {(creatorHits.length > 0 || sourceHits.length > 0) && (
          <div className="search-hits">
            {creatorHits.length > 0 && (
              <>
                <div className="section-label">Creator</div>
                <div className="search-chips">
                  {creatorHits.map((p) => (
                    <Link key={p.id} to={`/creators/${encodeURIComponent(p.id)}`} className="profile-chip">
                      <ProfileAvatar url={p.avatarUrl} name={p.name} className="avatar" />
                      <span className="discreet-text">{p.name}</span>
                      <span className="count">{p.videoCount} video</span>
                    </Link>
                  ))}
                </div>
              </>
            )}
            {sourceHits.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 14 }}>Fonti</div>
                <div className="search-chips">
                  {sourceHits.map((src) => (
                    <Link key={src.id} to="/sources" className="profile-chip">
                      <Rss size={14} />
                      <span className="discreet-text">{src.name}</span>
                      <span className="count">{src.videoCount} video</span>
                    </Link>
                  ))}
                </div>
              </>
            )}
            {results.length > 0 && <div className="section-label" style={{ marginTop: 18 }}>Video · {results.length}</div>}
          </div>
        )}
        <div className="list">
          {results.map((v) => (
            <VideoCard key={v.id} video={v} layout="row" onDecide={handleAction} />
          ))}
        </div>
        </>
      )}
    </>
  );
}
