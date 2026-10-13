import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pin, Search } from 'lucide-react';
import { listProfiles, updateProfile } from '../api/client.js';
import { ProfileAvatar } from '../components/ProfileAvatar.jsx';
import { SkeletonProfiles } from '../components/Skeletons.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { notifyProfilesChanged } from '../lib/profileEvents.js';

const SORTS = [
  { value: 'videos', label: 'Ordina: più video', fn: (a, b) => b.videoCount - a.videoCount },
  { value: 'name', label: 'Ordina: nome', fn: (a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) },
  { value: 'recent', label: 'Ordina: aggiunti di recente', fn: (a, b) => (b.lastAddedAt ?? '').localeCompare(a.lastAddedAt ?? '') },
  { value: 'removed', label: 'Ordina: più spariti', fn: (a, b) => b.removed - a.removed }
];

const FILTERS = [
  { value: 'all', label: 'Tutti i profili', fn: () => true },
  { value: 'multi', label: 'Con più canali', fn: (p) => p.channels.length > 1 },
  { value: 'nophoto', label: 'Senza foto', fn: (p) => !p.avatarUrl },
  { value: 'todo', label: 'Con video da scaricare', fn: (p) => p.toDownload > 0 },
  { value: 'removed', label: 'Con video spariti', fn: (p) => p.removed > 0 }
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function profileMeta(p) {
  const parts = [plural(p.channels.length, 'canale', 'canali')];
  if (p.sources.length) parts.push(plural(p.sources.length, 'fonte', 'fonti'));
  if (!p.avatarUrl) parts.push('senza foto');
  return parts.join(' · ');
}

// Colore stabile ricavato dal nome, per i creator senza foto.
function hueOf(name) {
  let h = 0;
  for (const ch of name ?? '') h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// Card creator con la foto in primo piano: l'immagine riempie la card,
// nome e canali le stanno sopra su una sfumatura; sotto, i tre numeri.
export function ProfileCard({ profile, onTogglePin }) {
  const initial = profile.name?.trim()?.charAt(0)?.toUpperCase() || '?';
  const hue = hueOf(profile.name);
  return (
    <Link to={`/creators/${encodeURIComponent(profile.id)}`} className={`creator-tile${profile.pinned ? ' pinned' : ''}`}>
      <div
        className="creator-photo"
        style={profile.avatarUrl ? undefined : { background: `linear-gradient(145deg, hsl(${hue} 32% 30%), hsl(${(hue + 40) % 360} 28% 16%))` }}
      >
        {profile.avatarUrl
          ? <img src={profile.avatarUrl} alt="" loading="lazy" />
          : <span className="creator-initial">{initial}</span>}
        <button
          type="button"
          className={`profile-pin${profile.pinned ? ' active' : ''}`}
          title={profile.pinned ? 'Togli dalla sidebar' : 'Fissa in sidebar'}
          aria-label={profile.pinned ? 'Togli dalla sidebar' : 'Fissa in sidebar'}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(profile); }}
        >
          <Pin size={14} fill={profile.pinned ? 'currentColor' : 'none'} />
        </button>
        <div className="creator-caption">
          <div className="creator-name discreet-text">{profile.name}</div>
          <div className="creator-meta">{profileMeta(profile)}</div>
        </div>
      </div>
      <div className="creator-stats">
        <span><b>{profile.videoCount}</b>video</span>
        <span><b>{profile.downloaded}</b>scaricati</span>
        <span className={profile.removed ? 'warn' : ''}><b>{profile.removed}</b>spariti</span>
      </div>
    </Link>
  );
}

// Creator: un profilo per persona, con i suoi canali. Sostituisce l'elenco
// infinito dei canali in sidebar, dove ora restano solo i fissati.
export function CreatorsPage() {
  useTitle('Creator');
  const [profiles, setProfiles] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('videos');
  const [filter, setFilter] = useState('all');

  useEffect(() => { listProfiles().then(setProfiles).catch((e) => setError(e.message)); }, []);

  async function togglePin(p) {
    try {
      const updated = await updateProfile(p.id, { pinned: !p.pinned });
      setProfiles((list) => list.map((x) => (x.id === p.id ? updated : x)));
      notifyProfilesChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  const visible = useMemo(() => {
    if (!profiles) return [];
    const q = query.trim().toLowerCase();
    const f = FILTERS.find((x) => x.value === filter).fn;
    return profiles
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.channels.some((c) => c.name.toLowerCase().includes(q)))
      .filter(f)
      .sort(SORTS.find((s) => s.value === sort).fn);
  }, [profiles, query, sort, filter]);

  if (error) return <div className="notice error">{error}</div>;
  if (!profiles) return <><div className="page-head"><h1>Creator</h1></div><SkeletonProfiles count={12} /></>;

  const channelCount = profiles.reduce((n, p) => n + p.channels.length, 0);
  const pinned = visible.filter((p) => p.pinned);
  const rest = visible.filter((p) => !p.pinned);

  return (
    <>
      <div className="page-head">
        <h1>Creator</h1>
        <span className="page-sub">{plural(profiles.length, 'profilo', 'profili')} · {plural(channelCount, 'canale', 'canali')}</span>
      </div>
      <div className="filter-bar">
        <div className="search-field">
          <Search size={16} />
          <input placeholder="Cerca un creator o un canale…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordina">
          {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtra">
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>

      {visible.length === 0 && <div className="empty-state">Nessun creator corrisponde.</div>}
      {pinned.length > 0 && (
        <>
          <div className="section-label">Fissati in sidebar</div>
          <div className="creator-grid">
            {pinned.map((p) => <ProfileCard key={p.id} profile={p} onTogglePin={togglePin} />)}
          </div>
        </>
      )}
      {rest.length > 0 && (
        <>
          {pinned.length > 0 && <div className="section-label">Tutti</div>}
          <div className="creator-grid">
            {rest.map((p) => <ProfileCard key={p.id} profile={p} onTogglePin={togglePin} />)}
          </div>
        </>
      )}
      {profiles.length > 0 && profiles.every((p) => p.channels.length === 1) && (
        <div className="hint" style={{ marginTop: 24 }}>
          Ogni canale è per ora un profilo a sé. Se una persona ha più canali, apri il suo profilo e usa «Unisci un altro canale».
        </div>
      )}
    </>
  );
}
