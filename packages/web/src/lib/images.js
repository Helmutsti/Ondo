// Copie ridotte di copertine e foto (server: media/imageCache.js). Negli
// elenchi un'immagine si chiede alla misura a cui si vede, non l'originale:
//   THUMB  640 → copertine delle card (~360 px, schermi ad alta densità)
//   SMALL  320 → miniature nelle righe e nelle code, foto grandi dei profili
//   AVATAR  96 → le foto tonde accanto ai titoli
// Solo per le immagini servite da Ondo: quelle remote (YouTube) restano com'erano.
export const THUMB = 640;
export const SMALL = 320;
export const AVATAR = 96;

export function sized(url, w) {
  if (!url || !/^\/media\/(thumbnails|avatars)\//.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}w=${w}`;
}
