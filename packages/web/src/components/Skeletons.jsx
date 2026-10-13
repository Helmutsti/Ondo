// Segnaposto mentre i dati arrivano: la pagina ha subito la sua forma (card
// grigie che "respirano") invece di restare vuota e riempirsi di colpo.
// aria-hidden: per uno screen reader conta l'avviso "Caricamento…", non le forme.

export function SkeletonGrid({ count = 12 }) {
  return (
    <div className="grid" aria-busy="true">
      <span className="sr-only">Caricamento…</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton" aria-hidden="true">
          <div className="sk sk-thumb" />
          <div className="sk sk-line" />
          <div className="sk sk-line short" />
          <div className="sk-info"><span className="sk sk-avatar" /><span className="sk sk-line tiny" /></div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 8, className = 'list' }) {
  return (
    <div className={className} aria-busy="true">
      <span className="sr-only">Caricamento…</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card-row skeleton" aria-hidden="true">
          <div className="thumb-wrap"><div className="sk sk-thumb" /></div>
          <div className="row-body"><div className="sk sk-line" /><div className="sk sk-line short" /></div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonProfiles({ count = 8 }) {
  return (
    <div className="profile-grid" aria-busy="true">
      <span className="sr-only">Caricamento…</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="profile-card skeleton" aria-hidden="true">
          <span className="sk sk-circle" />
          <span className="sk sk-line" style={{ width: '60%' }} />
          <span className="sk sk-line tiny" style={{ width: '40%' }} />
        </div>
      ))}
    </div>
  );
}
