import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { LayoutGrid, Rss, Plus, Menu, Settings, X, Users, ArrowRight } from 'lucide-react';
import { ProfileAvatar } from './ProfileAvatar.jsx';

// Barra in basso su schermo stretto: le voci della sidebar desktop (Home ·
// Sorgenti · Archiviati) più "+" per aggiungere un link e "Menu", che apre un
// pannello dal basso con quello che non ci sta — Impostazioni e i creator, che
// su mobile prima non erano raggiungibili affatto. La ricerca resta nella barra
// in alto, sempre visibile: una voce "Cerca" qui la duplicava.
export function MobileNav({ profiles = [] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const cls = ({ isActive }) => (isActive ? 'active' : '');

  // Il pannello si chiude da sé a ogni cambio di pagina (anche dal tasto
  // indietro), così non resta aperto sopra la pagina appena raggiunta.
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Sfondo fermo mentre il pannello è aperto: senza, su iPhone scorre la
  // pagina sotto invece dell'elenco dei creator.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const inMenu = location.pathname === '/settings' || location.pathname.startsWith('/creators/') || location.pathname.startsWith('/channels/');
  const pinned = profiles.filter((p) => p.pinned);

  return (
    <>
      <nav className="mobile-nav">
        <NavLink to="/" end className={cls}><LayoutGrid size={20} /><span>Libreria</span></NavLink>
        <NavLink to="/sources" className={cls}><Rss size={20} /><span>Sorgenti</span></NavLink>
        {/* "+" porta al campo "Aggiungi" di Sorgenti, già attivo (vedi
            SourcesPage: location.state.focusAdd). */}
        <NavLink to="/sources" state={{ focusAdd: true }} className="plus" aria-label="Aggiungi playlist o video">
          <Plus size={22} />
        </NavLink>
        <NavLink to="/creators" className={cls}><Users size={20} /><span>Creator</span></NavLink>
        <button type="button" className={inMenu || menuOpen ? 'active' : ''} onClick={() => setMenuOpen(true)} aria-expanded={menuOpen}>
          <Menu size={20} /><span>Menu</span>
        </button>
      </nav>

      {menuOpen && (
        <div className="sheet-overlay" onClick={() => setMenuOpen(false)}>
          <div className="sheet" role="dialog" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <span className="sheet-grip" aria-hidden="true" />
              <button type="button" className="sheet-close" onClick={() => setMenuOpen(false)} aria-label="Chiudi menu">
                <X size={18} />
              </button>
            </div>
            <div className="sheet-body">
              <NavLink to="/settings" className={({ isActive }) => `side-item${isActive ? ' active' : ''}`}>
                <Settings size={18} />Impostazioni
              </NavLink>
              <div className="side-div"></div>
              <div className="side-sec">Fissati</div>
              {pinned.length === 0 && <div className="side-empty">Fissa un creator dalla sua pagina per averlo qui.</div>}
              {pinned.map((p) => (
                <NavLink key={p.id} to={`/creators/${encodeURIComponent(p.id)}`} className={({ isActive }) => `side-item${isActive ? ' active' : ''}`}>
                  <ProfileAvatar url={p.avatarUrl} name={p.name} />
                  <span className="side-label discreet-text">{p.name}</span>
                </NavLink>
              ))}
              {profiles.length > 0 && (
                <Link to="/creators" className="side-all">Tutti i creator ({profiles.length}) <ArrowRight size={13} /></Link>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
