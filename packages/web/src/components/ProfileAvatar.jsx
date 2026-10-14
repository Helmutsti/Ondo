import { sized, AVATAR } from '../lib/images.js';

// Foto di un profilo creator, o l'iniziale del nome se non ne ha una. Il
// contenitore (classe passata da chi la usa) fissa taglia e forma; `size` è la
// copia ridotta da chiedere (lib/images.js), piccola per default.
export function ProfileAvatar({ url, name, className = 'avatar', size = AVATAR }) {
  return (
    <span className={className}>
      {url ? <img className="avatar-photo" src={sized(url, size)} alt="" /> : (name?.trim()?.charAt(0)?.toUpperCase() || '?')}
    </span>
  );
}
