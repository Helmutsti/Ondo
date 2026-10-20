import { NavLink, useLocation } from 'react-router-dom';
import { LayoutGrid, Rss, Users, Settings, Search } from 'lucide-react';

// Barra in basso su schermo stretto: cinque icone, senza scritte — Libreria,
// Creator, Cerca, Fonti, Impostazioni. Il resto è già altrove: un link si
// aggiunge dal campo in cima a Fonti, Attività è l'icona in alto a destra, i
// creator fissati sono in cima alla pagina Creator. Cerca non cambia pagina:
// apre il campo di ricerca in alto (vedi Layout, `onSearch`).
export function MobileNav({ onSearch, searchActive }) {
  const location = useLocation();
  const cls = ({ isActive }) => (isActive ? 'active' : '');
  // Creator acceso anche sulla pagina di un creator o di un canale.
  const inCreators = location.pathname.startsWith('/creators') || location.pathname.startsWith('/channels/');

  return (
    <nav className="mobile-nav" aria-label="Navigazione">
      <NavLink to="/" end className={cls} aria-label="Libreria" title="Libreria"><LayoutGrid size={23} /></NavLink>
      <NavLink to="/creators" className={inCreators ? 'active' : ''} aria-label="Creator" title="Creator"><Users size={23} /></NavLink>
      <button type="button" className={searchActive ? 'active' : ''} onClick={onSearch} aria-label="Cerca" title="Cerca"><Search size={23} /></button>
      <NavLink to="/sources" className={cls} aria-label="Fonti" title="Fonti"><Rss size={23} /></NavLink>
      <NavLink to="/settings" className={cls} aria-label="Impostazioni" title="Impostazioni"><Settings size={23} /></NavLink>
    </nav>
  );
}
