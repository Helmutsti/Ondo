import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

// "← Indietro": torna alla pagina da cui si è arrivati (con i suoi filtri,
// che stanno nell'URL). Se la pagina è stata aperta direttamente (link,
// segnalibro, refresh) non c'è un "prima" dentro l'app: si va a `fallback`.
export function BackLink({ fallback = '/', fallbackLabel = 'Libreria' }) {
  const location = useLocation();
  const navigate = useNavigate();
  if (location.key === 'default') {
    return <Link to={fallback} className="back-link desktop-only"><ArrowLeft size={14} />{fallbackLabel}</Link>;
  }
  return (
    <button type="button" className="back-link desktop-only" onClick={() => navigate(-1)}>
      <ArrowLeft size={14} />Indietro
    </button>
  );
}
