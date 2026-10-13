import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { LayoutGrid, Rss, Search, Settings, X, Users, Pin, ArrowRight, Activity } from 'lucide-react';
import { ActivityIndicator } from './ActivityIndicator.jsx';
import { useActivity } from '../lib/activityStore.js';
import { listProfiles } from '../api/client.js';
import { ProfileAvatar } from './ProfileAvatar.jsx';
import { onProfilesChanged } from '../lib/profileEvents.js';
import { MobileNav } from './MobileNav.jsx';
import { MiniPlayer } from './MiniPlayer.jsx';
import { ToastHost } from './ToastHost.jsx';
import { DialogHost } from './DialogHost.jsx';
import { registerNavigate } from '../lib/navigation.js';

export function Layout() {
  const [profiles, setProfiles] = useState([]);
  const [searchParams] = useSearchParams();
  const urlQ = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(urlQ);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => { registerNavigate(navigate); }, [navigate]);

  // Rifetch a ogni cambio pagina e quando un profilo cambia (fissato,
  // rinominato, foto): dataset piccolo, evita una sidebar disallineata.
  useEffect(() => {
    const load = () => listProfiles().then(setProfiles).catch(() => {});
    load();
    return onProfilesChanged(load);
  }, [location.pathname]);
  const pinned = profiles.filter((p) => p.pinned);
  const activeJobs = useActivity()?.active?.length ?? 0;

  // Unica barra di ricerca (punto 10): sincronizzata con la query attiva
  // dell'URL — su /search?q=… mostra il termine cercato, altrove si svuota.
  // Scatta solo al cambio di `q`, non a ogni tasto, quindi non disturba la
  // digitazione (la ricerca parte solo su Invio, vedi submitSearch).
  useEffect(() => setQuery(urlQ), [urlQ]);

  function submitSearch(e) {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed) navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  // Punto 14 del backlog: svuota rapidamente il campo; se si è già sulla
  // pagina Cerca, torna in Home invece di lasciarla con la query nell'URL ma
  // il campo vuoto (disallineati).
  function clearSearch() {
    setQuery('');
    if (location.pathname === '/search') navigate('/');
  }

  const navCls = ({ isActive }) => `side-item${isActive ? ' active' : ''}`;

  return (
    <div className="shell">
      <ToastHost />
      <DialogHost />
      <header className="topbar">
        <Link to="/" className="logo"><img src="/ondo-logo.svg" alt="Ondo" /></Link>
        <form className="search-box" onSubmit={submitSearch}>
          <Search size={16} />
          <input
            placeholder="Cerca video, creator, argomenti"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" className="search-clear" onClick={clearSearch} aria-label="Svuota ricerca">
              <X size={14} />
            </button>
          )}
        </form>
        <ActivityIndicator />
      </header>
      <div className="body-area">
        <nav className="sidebar">
          <NavLink to="/" end className={navCls}><LayoutGrid size={16} />Libreria</NavLink>
          <NavLink to="/creators" end className={navCls}><Users size={16} />Creator</NavLink>
          <NavLink to="/sources" className={navCls}><Rss size={16} />Fonti</NavLink>
          <NavLink to="/activity" className={navCls}><Activity size={16} />Attività{activeJobs > 0 && <span className="side-badge">{activeJobs}</span>}</NavLink>
          <NavLink to="/settings" className={navCls}><Settings size={16} />Impostazioni</NavLink>
          <div className="side-div"></div>
          <div className="side-sec"><Pin size={11} style={{ verticalAlign: -1 }} /> Fissati</div>
          {pinned.length === 0 && profiles.length > 0 && (
            <div className="side-empty">Fissa un creator dalla sua pagina per averlo qui.</div>
          )}
          {pinned.map((p) => (
            <NavLink key={p.id} to={`/creators/${encodeURIComponent(p.id)}`} className={navCls}>
              <ProfileAvatar url={p.avatarUrl} name={p.name} />
              <span className="discreet-text">{p.name}</span>
            </NavLink>
          ))}
          {profiles.length > 0 && (
            <Link to="/creators" className="side-all">Tutti i creator ({profiles.length}) <ArrowRight size={13} /></Link>
          )}
        </nav>
        <main className="main">
          <Outlet />
        </main>
      </div>
      {/* Mini-player persistente (M54): montato FUORI dall'<Outlet/>, così il suo
          <video> sopravvive al cambio di route e la riproduzione non si taglia. */}
      <MiniPlayer />
      <MobileNav profiles={profiles} />
    </div>
  );
}
