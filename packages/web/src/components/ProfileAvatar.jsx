// Foto di un profilo creator, o l'iniziale del nome se non ne ha una. Il
// contenitore (classe passata da chi la usa) fissa taglia e forma.
export function ProfileAvatar({ url, name, className = 'avatar' }) {
  return (
    <span className={className}>
      {url ? <img className="avatar-photo" src={url} alt="" /> : (name?.trim()?.charAt(0)?.toUpperCase() || '?')}
    </span>
  );
}
