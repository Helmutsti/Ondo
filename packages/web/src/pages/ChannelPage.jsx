import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { getProfileIdForChannel } from '../api/client.js';

// I vecchi link /channels/:key (segnalibri, cronologia) portano al profilo
// creator che oggi contiene quel canale.
export function ChannelPage() {
  const { key } = useParams();
  const [target, setTarget] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getProfileIdForChannel(key).then((r) => setTarget(r.id)).catch((e) => setError(e.message));
  }, [key]);

  if (error) return <div className="notice error">{error}</div>;
  if (!target) return <div className="empty-state"><span className="spinner"></span></div>;
  return <Navigate to={`/creators/${encodeURIComponent(target)}`} replace />;
}
