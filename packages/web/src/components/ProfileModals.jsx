import { useEffect, useMemo, useRef, useState } from 'react';
import { CloudDownload, ImageUp, Search, Check } from 'lucide-react';
import {
  fetchChannelPhoto, setChannelPhoto, uploadProfilePhoto, clearProfilePhoto, listProfiles, mergeChannels
} from '../api/client.js';
import { ProfileAvatar } from './ProfileAvatar.jsx';
import { showToast } from '../lib/toast.js';

const dateIt = (iso) => (iso ? new Date(iso).toLocaleDateString('it-IT') : null);

// "Foto del profilo": la foto di uno dei canali del profilo, oppure
// un'immagine caricata. Niente si scarica da solo: la foto di un canale arriva
// da YouTube solo premendo "Scarica dal canale".
export function PhotoModal({ profile, onClose, onSaved }) {
  const current = profile.avatarType === 'custom' ? 'custom' : profile.avatarChannelKey;
  const [selected, setSelected] = useState(current);
  const [channels, setChannels] = useState(profile.channels);
  const [fetching, setFetching] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function download(key) {
    setFetching(key);
    setError(null);
    try {
      const r = await fetchChannelPhoto(key);
      setChannels((list) => list.map((c) => (c.key === key ? { ...c, photoUrl: r.photoUrl, photo: { version: r.fetchedAt }, photoError: null } : c)));
      setSelected(key);
    } catch (e) {
      setError(e.message);
      setChannels((list) => list.map((c) => (c.key === key ? { ...c, photoError: e.message } : c)));
    } finally {
      setFetching(null);
    }
  }

  function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setError('Usa un\'immagine JPEG, PNG o WebP.'); return; }
    if (f.size > 5 * 1024 * 1024) { setError('Immagine troppo grande (massimo 5 MB).'); return; }
    setError(null);
    setFile(f);
    setSelected('custom');
  }

  async function save(action) {
    setBusy(true);
    setError(null);
    try {
      let updated;
      if (action === 'clear') updated = await clearProfilePhoto(profile.id);
      else if (selected === 'custom') updated = file ? await uploadProfilePhoto(profile.id, file) : null;
      else if (selected) updated = await setChannelPhoto(profile.id, selected);
      showToast(action === 'clear' ? 'Foto tolta.' : 'Foto del profilo aggiornata.', 'success');
      onSaved(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const unchanged = selected === current && !(selected === 'custom' && file);
  const customUrl = preview ?? (profile.avatarType === 'custom' ? profile.avatarUrl : null);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Foto del profilo</h3>
        <p>Scegli la foto di uno dei canali del profilo, oppure carica un'immagine tua. Niente viene scaricato in automatico.</p>
        <div className="modal-sec">Dai canali</div>
        <div className="photo-options">
          {channels.map((c) => {
            const has = !!c.photoUrl;
            const isSel = selected === c.key;
            return (
              <div
                key={c.key}
                className={`photo-option${isSel ? ' selected' : ''}${has ? '' : ' empty'}`}
                onClick={() => has && setSelected(c.key)}
                role="radio"
                aria-checked={isSel}
              >
                <span className="photo-circle">
                  {has ? <img className="avatar-photo" src={c.photoUrl} alt="" /> : <CloudDownload size={26} />}
                </span>
                <span className="photo-name discreet-text">{c.name}</span>
                <span className="photo-sub">
                  {current === c.key ? 'In uso · ' : ''}
                  {has ? `scaricata il ${dateIt(c.photo?.version) ?? '—'}` : (c.photoError ? 'Non trovata' : 'Non ancora scaricata')}
                </span>
                <button
                  type="button"
                  className="btn small"
                  disabled={fetching !== null}
                  onClick={(e) => { e.stopPropagation(); download(c.key); }}
                >
                  {fetching === c.key ? <span className="spinner small" /> : <CloudDownload size={13} />}
                  {has ? 'Riscarica' : 'Scarica dal canale'}
                </button>
              </div>
            );
          })}
          <div
            className={`photo-option${selected === 'custom' ? ' selected' : ''}`}
            onClick={() => (customUrl ? setSelected('custom') : inputRef.current?.click())}
            role="radio"
            aria-checked={selected === 'custom'}
          >
            <span className="photo-circle">
              {customUrl ? <img className="avatar-photo" src={customUrl} alt="" /> : <ImageUp size={26} />}
            </span>
            <span className="photo-name">Immagine tua</span>
            <span className="photo-sub">
              {current === 'custom' && !file ? 'In uso · ' : ''}JPEG, PNG o WebP, ritaglio circolare
            </span>
            <button type="button" className="btn small" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>
              <ImageUp size={13} />{customUrl ? 'Cambia immagine' : 'Carica'}
            </button>
            <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pickFile} />
          </div>
        </div>
        {error && <div className="notice error" style={{ marginTop: 14 }}>{error}</div>}
        <div className="modal-actions" style={{ marginTop: 18 }}>
          {profile.avatarType && (
            <button className="btn" style={{ marginRight: 'auto' }} disabled={busy} onClick={() => save('clear')}>Togli la foto</button>
          )}
          <button className="btn" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" disabled={busy || unchanged || !selected} onClick={() => save('use')}>
            Usa questa foto
          </button>
        </div>
      </div>
    </div>
  );
}

// Nome ridotto all'essenziale per i suggerimenti: minuscole, senza accenti né
// simboli, senza le parole che quasi tutti i canali di questa libreria hanno.
const NOISE = new Set(['asmr', 'official', 'channel', 'tv', 'the', 'yt']);
function nameTokens(name) {
  return (name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !NOISE.has(t));
}
function similar(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  return ta.some((x) => tb.some((y) => x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y))));
}

// "Unisci canali": sposta canali di altri profili dentro questo. Un canale sta
// in un solo profilo; i profili rimasti vuoti spariscono.
export function MergeModal({ profile, onClose, onSaved }) {
  const [profiles, setProfiles] = useState(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { listProfiles().then(setProfiles).catch((e) => setError(e.message)); }, []);

  // Una riga per canale, con il profilo in cui sta ora.
  const rows = useMemo(() => {
    if (!profiles) return [];
    const out = [];
    for (const p of profiles) {
      if (p.id === profile.id) continue;
      for (const c of p.channels) {
        out.push({ ...c, owner: p, alone: p.channels.length === 1, avatarUrl: c.photoUrl ?? (p.channels.length === 1 ? p.avatarUrl : null) });
      }
    }
    return out;
  }, [profiles, profile.id]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.owner.name.toLowerCase().includes(q))
    : rows;
  const names = [profile.name, ...profile.channels.map((c) => c.name)];
  const suggested = q ? [] : matches.filter((r) => names.some((n) => similar(n, r.name)));
  const others = q ? matches : matches.filter((r) => !suggested.includes(r));

  function toggle(key) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await mergeChannels(profile.id, [...picked]);
      showToast(`${picked.size === 1 ? 'Canale unito' : `${picked.size} canali uniti`} a "${updated.name}".`, 'success');
      onSaved(updated);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  const row = (r) => (
    <label key={r.key} className={`merge-row${picked.has(r.key) ? ' selected' : ''}`}>
      <input type="checkbox" checked={picked.has(r.key)} onChange={() => toggle(r.key)} />
      <ProfileAvatar url={r.avatarUrl} name={r.name} className="avatar merge-avatar" />
      <span className="merge-text">
        <span className="merge-name discreet-text">{r.name}</span>
        <span className="merge-sub">
          {r.count} video · {r.alone ? 'profilo a sé' : <>già nel profilo "<span className="discreet-text">{r.owner.name}</span>"</>}
        </span>
      </span>
      {!r.alone && picked.has(r.key) && <span className="merge-move">verrà spostato</span>}
    </label>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Aggiungi canali a "<span className="discreet-text">{profile.name}</span>"</h3>
        <div className="search-field">
          <Search size={16} />
          <input autoFocus placeholder={`Cerca tra i ${rows.length} canali…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="merge-list">
          {!profiles && !error && <div className="empty-state"><span className="spinner"></span></div>}
          {suggested.length > 0 && <div className="modal-sec">Suggeriti (nome simile)</div>}
          {suggested.map(row)}
          {suggested.length > 0 && others.length > 0 && <div className="modal-sec">Tutti i canali</div>}
          {others.map(row)}
          {profiles && matches.length === 0 && <div className="side-empty">Nessun canale corrisponde.</div>}
        </div>
        {error && <div className="notice error" style={{ marginTop: 14 }}>{error}</div>}
        <div className="modal-actions" style={{ marginTop: 18 }}>
          <button className="btn" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" disabled={busy || picked.size === 0} onClick={save}>
            <Check size={14} />{picked.size > 1 ? `Unisci ${picked.size} canali` : 'Unisci'}
          </button>
        </div>
      </div>
    </div>
  );
}
