import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, GitMerge, MoreVertical, Pencil, Pin, Rss, Camera, Split, WandSparkles } from 'lucide-react';
import { openMetadataWizard } from '../lib/metadataWizard.js';
import { useActivity } from '../lib/activityStore.js';
import {
  getProfile, listProfileVideos, updateProfile, splitChannel,
  setHidden, setFavorite, deleteVideo, triggerJob, refreshMetadata
} from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { ProfileAvatar } from '../components/ProfileAvatar.jsx';
import { PhotoModal, MergeModal } from '../components/ProfileModals.jsx';
import { useHideWithPrompt } from '../hooks/useHideWithPrompt.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';
import { startDownload } from '../lib/downloadActions.js';
import { formatBytes, channelKey } from '../lib/format.js';
import { showToast } from '../lib/toast.js';
import { confirmDialog } from '../lib/dialog.js';
import { notifyProfilesChanged } from '../lib/profileEvents.js';
import { statusColor } from '../lib/status.js';

// Filtri della griglia: "Tutti" esclude i nascosti, che hanno la loro chip.
const FILTERS = [
  { value: 'todo', label: 'Da scaricare', dot: 'available', fn: (v) => !v.hidden && v.presence === 'present' && v.download === 'none' },
  { value: 'downloaded', label: 'Scaricati', dot: 'downloaded', fn: (v) => !v.hidden && v.download === 'downloaded' },
  { value: 'removed', label: 'Spariti da YouTube', dot: 'removed', fn: (v) => !v.hidden && v.presence === 'removed' },
  { value: 'failed', label: 'Falliti', dot: 'failed', fn: (v) => !v.hidden && v.download === 'failed' },
  { value: 'hidden', label: 'Nascosti', dot: 'hidden', fn: (v) => v.hidden }
];

// Profilo creator: chi è (foto, nome), di cosa è fatto (canali, fonti) e i suoi
// video, con i filtri per stato e per canale.
export function CreatorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState(null);
  const [channel, setChannel] = useState('');
  const [sort, setSort] = useState('uploadDate');
  const [editing, setEditing] = useState(false);
  const [modal, setModal] = useState(null); // 'photo' | 'merge'
  const [chipMenu, setChipMenu] = useState(null);
  const nameRef = useRef(null);
  const { requestHide, modal: hideModal } = useHideWithPrompt({ onDone: reload, onError: setError });

  function reload() {
    getProfile(id).then(setProfile).catch((e) => setError(e.message));
    listProfileVideos(id).then(setVideos).catch((e) => setError(e.message));
  }

  useEffect(() => {
    setProfile(null);
    setVideos(null);
    setError(null);
    setFilter(null);
    setChannel('');
    reload();
  }, [id]);

  useTitle(profile?.name);

  // Un lavoro appena finito (download, metadati) cambia i video del profilo.
  const lastFinished = useActivity()?.finished?.[0]?.id;
  useEffect(() => { if (lastFinished) reload(); }, [lastFinished]);

  useEffect(() => {
    if (!chipMenu) return undefined;
    const close = () => setChipMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [chipMenu]);

  function applyUpdate(updated) {
    if (updated) setProfile(updated);
    setModal(null);
    notifyProfilesChanged();
    reload();
  }

  async function saveName(value) {
    setEditing(false);
    const name = value.trim();
    if (name === profile.name) return;
    try {
      applyUpdate(await updateProfile(id, { name }));
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function togglePin() {
    try {
      applyUpdate(await updateProfile(id, { pinned: !profile.pinned }));
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function handleSplit(c) {
    setChipMenu(null);
    const ok = await confirmDialog({
      title: 'Separare il canale?',
      message: `"${c.name}" diventa un profilo a sé, con i suoi ${c.count} video. Potrai riunirlo quando vuoi.`,
      confirmLabel: 'Sposta in un nuovo profilo'
    });
    if (!ok) return;
    try {
      const created = await splitChannel(id, c.key);
      notifyProfilesChanged();
      showToast(`"${created.name}" ora è un profilo a sé.`, 'success', 6000, () => navigate(`/creators/${created.id}`));
      reload();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // Stesso cablaggio della Home e dell'Archivio: un solo onDecide per la card.
  async function handleAction(videoId, kind) {
    try {
      if (kind === 'download') {
        const title = videos.find((v) => v.id === videoId)?.title;
        await startDownload(videoId, { triggerJob, onSettled: reload, title });
        return;
      }
      if (kind === 'hide') { requestHide(videos.find((v) => v.id === videoId)); return; }
      if (kind === 'metadata') { await refreshMetadata(videoId); reload(); return; }
      if (kind === 'favorite' || kind === 'unfavorite') { await setFavorite(videoId, kind === 'favorite'); reload(); return; }
      if (kind === 'deletevideo') {
        await deleteVideo(videoId);
        showToast('Video cancellato definitivamente.', 'success');
        reload();
        return;
      }
      if (kind === 'unhide') await setHidden(videoId, false);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  const byChannel = useMemo(
    () => (videos ?? []).filter((v) => !channel || channelKey(v) === channel),
    [videos, channel]
  );
  const counts = useMemo(() => {
    const c = { all: byChannel.filter((v) => !v.hidden).length };
    for (const f of FILTERS) c[f.value] = byChannel.filter(f.fn).length;
    return c;
  }, [byChannel]);
  const shown = useMemo(() => {
    const fn = FILTERS.find((f) => f.value === filter)?.fn ?? ((v) => !v.hidden);
    return sortVideos(byChannel.filter(fn), sort);
  }, [byChannel, filter, sort]);

  if (error && !profile) return <div className="notice error">{error}</div>;
  if (!profile) return <div className="empty-state"><span className="spinner"></span></div>;

  const multi = profile.channels.length > 1;

  return (
    <>
      <Link to="/creators" className="back-link desktop-only"><ArrowLeft size={14} />Creator</Link>
      {error && <div className="notice error">{error}</div>}

      <div className="profile-head">
        <button type="button" className="profile-photo" onClick={() => setModal('photo')} title="Cambia foto">
          <ProfileAvatar url={profile.avatarUrl} name={profile.name} className="profile-photo-img" />
          <span className="profile-photo-edit"><Camera size={14} />Cambia</span>
        </button>
        <div className="profile-title">
          {editing ? (
            <input
              ref={nameRef}
              className="profile-name-input"
              defaultValue={profile.renamed ? profile.name : ''}
              placeholder={profile.name}
              autoFocus
              maxLength={120}
              onBlur={(e) => saveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
          ) : (
            <h1 className="profile-name">
              <span className="discreet-text">{profile.name}</span>
              <button type="button" className="profile-rename" onClick={() => setEditing(true)} title="Rinomina" aria-label="Rinomina">
                <Pencil size={16} />
              </button>
            </h1>
          )}
          {editing && <div className="hint">Invio per salvare, Esc per annullare. Vuoto = torna al nome del canale.</div>}
          <div className="profile-stats">
            <span><b>{profile.videoCount}</b> video</span>
            <span><b>{profile.downloaded}</b> scaricati</span>
            <span><b>{profile.toDownload}</b> da scaricare</span>
            {profile.removed > 0 && <span><b>{profile.removed}</b> spariti da YouTube</span>}
            {profile.bytesOnDisk > 0 && <span><b>{formatBytes(profile.bytesOnDisk)}</b> su disco</span>}
          </div>
        </div>
        <div className="profile-actions">
          <button className="btn" disabled={!videos?.length} onClick={() => openMetadataWizard({ label: `Profilo ${profile.name}`, videos, allLabel: 'Tutto il profilo' })}>
            <WandSparkles size={14} />Aggiorna metadati…
          </button>
          <button className={`btn${profile.pinned ? ' btn-active' : ''}`} onClick={togglePin} title={profile.pinned ? 'Togli dalla sidebar' : 'Mostra in sidebar'}>
            <Pin size={14} fill={profile.pinned ? 'currentColor' : 'none'} />{profile.pinned ? 'Fissato' : 'Fissa in sidebar'}
          </button>
        </div>
      </div>

      <div className="profile-panels">
        <div className="profile-panel">
          <div className="section-label">Canali YouTube del profilo</div>
          <div className="profile-chips">
            {profile.channels.map((c) => (
              <span key={c.key} className="profile-chip">
                <ProfileAvatar url={c.photoUrl} name={c.name} className="avatar" />
                <span className="discreet-text">{c.name}</span>
                <span className="count">{c.count} video</span>
                {multi && (
                  <span className="chip-menu-wrap">
                    <button
                      type="button"
                      className="chip-menu-btn"
                      aria-label={`Azioni su ${c.name}`}
                      onClick={(e) => { e.stopPropagation(); setChipMenu(chipMenu === c.key ? null : c.key); }}
                    >
                      <MoreVertical size={14} />
                    </button>
                    {chipMenu === c.key && (
                      <div className="menu-list chip-menu" onClick={(e) => e.stopPropagation()}>
                        <button className="menu-item" onClick={() => handleSplit(c)}>
                          <Split size={15} />Sposta in un nuovo profilo
                        </button>
                      </div>
                    )}
                  </span>
                )}
              </span>
            ))}
            <button type="button" className="profile-chip add" onClick={() => setModal('merge')}>
              <GitMerge size={14} />Unisci un altro canale
            </button>
          </div>
        </div>
        <div className="profile-panel">
          <div className="section-label">Fonti che portano suoi video</div>
          {profile.sources.length === 0 ? (
            <div className="side-empty" style={{ padding: 0 }}>Nessuna fonte: i suoi video sono arrivati da link diretti.</div>
          ) : (
            <div className="profile-chips">
              {profile.sources.map((s) => (
                <Link key={s.id} to="/sources" className="profile-chip">
                  <Rss size={14} />
                  <span className="discreet-text">{s.name}</span>
                  <span className="count">{s.count}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="chips">
        <div className={`chip${filter == null ? ' active' : ''}`} onClick={() => setFilter(null)}>
          Tutti{counts.all > 0 && <span className="count">{counts.all}</span>}
        </div>
        {FILTERS.filter((f) => counts[f.value] > 0 || filter === f.value).map((f) => (
          <div key={f.value} className={`chip${filter === f.value ? ' active' : ''}`} onClick={() => setFilter(f.value)}>
            <span className="dot" style={{ background: statusColor(f.dot) }}></span>
            {f.label}<span className="count">{counts[f.value]}</span>
          </div>
        ))}
      </div>
      <div className="filter-bar">
        {multi && (
          <select className={channel ? 'discreet-text' : undefined} value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Filtra per canale">
            <option value="">Tutti i canali</option>
            {profile.channels.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
          </select>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordina per">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {!videos ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : shown.length === 0 ? (
        <div className="empty-state">Nessun video in questa vista.</div>
      ) : (
        <div className="grid">
          {shown.map((v) => <VideoCard key={v.id} video={v} onDecide={handleAction} />)}
        </div>
      )}

      {modal === 'photo' && <PhotoModal profile={profile} onClose={() => setModal(null)} onSaved={applyUpdate} />}
      {modal === 'merge' && <MergeModal profile={profile} onClose={() => setModal(null)} onSaved={applyUpdate} />}
      {hideModal}
    </>
  );
}
