import { Link } from 'react-router-dom';
import { Cookie, RefreshCw, CloudDownload, Copy } from 'lucide-react';
import { startBulkDownload } from '../lib/downloadActions.js';
import { sized, SMALL } from '../lib/images.js';
import { showToast } from '../lib/toast.js';

// "Problemi" non è una lista indistinta: i video sono raggruppati per causa
// (la categoria che il classificatore degli errori di yt-dlp ha dato al
// download fallito), con UNA azione per gruppo.
const GROUPS = {
  blocked: { title: (n) => `${n} bloccati da YouTube (anti-bot o troppe richieste)`, desc: 'Non è un problema dei video: YouTube sta frenando le richieste. Riprova più tardi, o carica cookie aggiornati.', tone: 'accent', actions: ['cookies', 'retry'] },
  restricted: { title: (n) => `${n} con accesso limitato`, desc: 'Limite d\'età, video per i membri o non disponibile nel tuo paese: servono i cookie di un account che possa vederli.', tone: 'warn', actions: ['cookies'] },
  format: { title: (n) => `${n} con formato non disponibile`, desc: 'La qualità scelta non esiste per questi video, o YouTube ha rifiutato i frammenti (403).', tone: 'err', actions: ['best'] },
  network: { title: (n) => `${n} non raggiunti o rifiutati dal sito`, desc: 'Il sito non ha risposto, o ha rifiutato la richiesta con il suo filtro anti-bot (403). Non dipende dalla qualità: di solito riprovando passa.', tone: 'err', actions: ['retry'] },
  environment: { title: (n) => `${n} per un problema della macchina`, desc: null, tone: 'err', actions: ['retry'] },
  internal: { title: (n) => `${n} per un errore interno di Ondo`, desc: 'Errore nel leggere i file prodotti da yt-dlp.', tone: 'err', actions: ['retry'] },
  gone: { title: (n) => `${n} non più su YouTube`, desc: 'Privati, rimossi o non disponibili: non c\'è più niente da scaricare.', tone: 'muted', actions: [] },
  unknown: { title: (n) => `${n} con errore non classificato`, desc: null, tone: 'muted', actions: ['copy', 'retry'] }
};
const ORDER = ['blocked', 'restricted', 'format', 'network', 'environment', 'internal', 'unknown', 'gone'];
const GONE = new Set(['removed', 'private', 'unavailable']);

// Errori salvati prima della v3.0.4: un 403 sulla lettura dei metadati
// (Rumble) era finito tra i problemi di formato, ma la qualità non c'entra.
const REFUSED = /unable to download (?:json metadata|webpage|api page)[^\n]*(?:403|forbidden)/i;

function groupOf(video) {
  if (typeof video.error === 'object' && REFUSED.test(video.error?.message ?? '')) return 'network';
  const c = typeof video.error === 'object' ? video.error?.category : null;
  if (!c) return 'unknown';
  if (GONE.has(c)) return 'gone';
  return GROUPS[c] ? c : 'unknown';
}

function errorText(video) {
  return typeof video.error === 'object' ? (video.error?.message ?? '') : (video.error ?? '');
}

export function ProblemGroups({ videos, onChanged }) {
  const byGroup = new Map();
  for (const v of videos) {
    const g = groupOf(v);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(v);
  }

  async function retry(list, maxHeight) {
    await startBulkDownload(list.map((v) => v.id), { onSettled: onChanged, maxHeight, askQuality: false });
  }

  function copy(list) {
    const text = list.map((v) => `${v.id} — ${v.title ?? ''}\n  ${errorText(v)}`).join('\n');
    navigator.clipboard?.writeText(text).then(
      () => showToast('Dettagli copiati.', 'success', 2000),
      () => showToast('Copia non riuscita.', 'error')
    );
  }

  return (
    <div className="problem-groups">
      {ORDER.filter((g) => byGroup.has(g)).map((g) => {
        const list = byGroup.get(g);
        const def = GROUPS[g];
        const first = list[0]?.error;
        const desc = def.desc ?? (typeof first === 'object' ? [first?.hint, first?.message].filter(Boolean).join(' — ') : first);
        return (
          <section key={g} className={`problem-group ${def.tone}`}>
            <div className="problem-head">
              <span className="problem-dot" />
              <div className="problem-text">
                <b>{def.title(list.length)}</b>
                {desc && <span className="discreet-text">{desc}</span>}
              </div>
              <div className="problem-actions">
                {def.actions.includes('cookies') && <Link to="/settings" className="btn small btn-primary"><Cookie size={13} />Carica cookie</Link>}
                {def.actions.includes('best') && <button className="btn small" onClick={() => retry(list, null)}><CloudDownload size={13} />Scarica alla migliore disponibile</button>}
                {def.actions.includes('copy') && <button className="btn small" onClick={() => copy(list)}><Copy size={13} />Copia dettagli</button>}
                {def.actions.includes('retry') && <button className="btn small" onClick={() => retry(list)}><RefreshCw size={13} />{g === 'blocked' ? 'Riprova ora' : 'Riprova'}</button>}
              </div>
            </div>
            <div className="problem-tiles">
              {list.slice(0, 12).map((v) => (
                <Link key={v.id} to={`/videos/${encodeURIComponent(v.id)}`} className="problem-tile" title={errorText(v)}>
                  <span className="problem-thumb">{v.thumbnailUrl && <img src={sized(v.thumbnailUrl, SMALL)} alt="" loading="lazy" />}</span>
                  <span className="problem-title discreet-text">{v.title ?? v.id}</span>
                </Link>
              ))}
              {list.length > 12 && <span className="problem-more">e altri {list.length - 12}</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
