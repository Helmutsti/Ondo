import { useState } from 'react';
import { Pencil, Lock, LockOpen, WandSparkles, Undo2, History } from 'lucide-react';
import { setVideoField, setFieldLock, restoreHistory } from '../api/client.js';
import { openMetadataWizard, FIELD_LABEL } from '../lib/metadataWizard.js';
import { showToast } from '../lib/toast.js';

const ROWS = [
  { field: 'title', editable: true },
  { field: 'description', editable: true, multiline: true },
  { field: 'tags', editable: true },
  { field: 'uploadDate', editable: true },
  { field: 'thumbnail', editable: false },
  { field: 'chapters', editable: false }
];

const dateIt = (iso, opts = { day: 'numeric', month: 'long', year: 'numeric' }) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('it-IT', opts);
};

function display(field, v) {
  if (field === 'tags') return v.tags?.length ? v.tags.join(' · ') : '—';
  if (field === 'uploadDate') return dateIt(v.uploadDate) ?? '—';
  if (field === 'thumbnail') return v.thumbnailUrl ? 'presente' : '—';
  if (field === 'chapters') return v.chapters?.length ? `${v.chapters.length} capitoli` : '—';
  return v[field] || '—';
}

function editValue(field, v) {
  if (field === 'tags') return (v.tags ?? []).join(', ');
  if (field === 'uploadDate') return v.uploadDate ? String(v.uploadDate).slice(0, 10) : '';
  return v[field] ?? '';
}

// Scheda "Metadati": ogni campo si modifica a mano (✎) e si blocca (🔒). Un
// campo modificato a mano si blocca da solo, come in Calibre: i prossimi
// aggiornamenti da YouTube non lo toccano.
export function VideoMetadataPanel({ video, onChange }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const locks = new Set(video.locks ?? []);
  const last = video.metadataHistory?.find((e) => e.origin !== 'manual');

  function startEdit(field) {
    setEditing(field);
    setDraft(editValue(field, video));
  }

  async function save() {
    setBusy(true);
    try {
      onChange(await setVideoField(video.id, editing, draft));
      showToast(`${FIELD_LABEL[editing]} salvat${editing === 'tags' ? 'i' : 'o'} e bloccat${editing === 'tags' ? 'i' : 'o'}.`, 'success', 2500);
      setEditing(null);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function toggleLock(field) {
    try {
      onChange(await setFieldLock(video.id, field, !locks.has(field)));
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  return (
    <div className="meta-panel">
      <div className="meta-top">
        <span className="hint">
          {video.enrichedAt
            ? `Ultimo aggiornamento: ${dateIt(video.enrichedAt, { day: '2-digit', month: '2-digit', year: 'numeric' })}${last?.label ? ` («${last.label}»)` : ''}`
            : 'Metadati completi mai recuperati.'}
        </span>
        <button className="btn small" onClick={() => openMetadataWizard({ label: video.title ?? video.id, videos: [video], allLabel: 'Questo video' })}>
          <WandSparkles size={13} />Aggiorna da YouTube…
        </button>
      </div>
      <div className="meta-rows">
        {ROWS.map(({ field, editable, multiline }) => {
          const locked = locks.has(field);
          const manual = video.metadataHistory?.find((e) => e.field === field)?.origin === 'manual';
          return (
            <div key={field} className={`meta-row${locked ? ' locked' : ''}`}>
              <div className="meta-key">
                {FIELD_LABEL[field]}
                {manual && <small>modificato a mano</small>}
              </div>
              <div className="meta-val">
                {editing === field ? (
                  <div className="meta-edit">
                    {multiline
                      ? <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} autoFocus />
                      : <input type={field === 'uploadDate' ? 'date' : 'text'} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(null); }} />}
                    {field === 'tags' && <span className="hint">Separati da virgola.</span>}
                    <div className="meta-edit-actions">
                      <button className="btn small" onClick={() => setEditing(null)}>Annulla</button>
                      <button className="btn small btn-primary" disabled={busy} onClick={save}>Salva e blocca</button>
                    </div>
                  </div>
                ) : (
                  <span className={`discreet-text${field === 'description' ? ' meta-long' : ''}`}>{display(field, video)}</span>
                )}
              </div>
              <div className="meta-actions">
                {editable && editing !== field && (
                  <button className="icon-btn small-icon" title="Modifica" aria-label={`Modifica ${FIELD_LABEL[field]}`} onClick={() => startEdit(field)}><Pencil size={14} /></button>
                )}
                <button
                  className={`icon-btn small-icon${locked ? ' lock-on' : ''}`}
                  title={locked ? 'Bloccato: gli aggiornamenti non lo toccano. Clicca per sbloccare' : 'Blocca: gli aggiornamenti non lo toccheranno'}
                  aria-label={locked ? `Sblocca ${FIELD_LABEL[field]}` : `Blocca ${FIELD_LABEL[field]}`}
                  onClick={() => toggleLock(field)}
                >
                  {locked ? <Lock size={14} /> : <LockOpen size={14} />}
                </button>
              </div>
            </div>
          );
        })}
        <div className="meta-row">
          <div className="meta-key">Canale</div>
          <div className="meta-val"><span className="discreet-text">{video.channel?.name ?? '—'}</span></div>
          <div className="meta-actions" />
        </div>
      </div>
    </div>
  );
}

const ORIGIN_TEXT = {
  wizard: 'wizard',
  refresh: 'aggiornamento',
  review: 'scelta in revisione',
  kept: 'scelta in revisione',
  manual: 'tu · campo bloccato',
  restore: 'ripristino'
};

function entryTitle(e) {
  const name = FIELD_LABEL[e.field] ?? e.field;
  if (e.origin === 'kept') return `${name} mantenuta`;
  if (e.origin === 'manual') return `${name} modificat${e.field === 'tags' ? 'i' : 'o'} a mano`;
  if (e.origin === 'restore') return `${name} ripristinat${e.field === 'tags' ? 'i' : 'o'}`;
  if (e.field === 'thumbnail') return 'Copertina sostituita';
  return `${name} cambiat${e.field === 'tags' ? 'i' : 'o'}`;
}

function short(value) {
  if (value == null || value === '') return 'vuoto';
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

// Scheda "Cronologia": ogni cambio con l'origine e la data; ogni voce si può
// ripristinare (copertine comprese, finché l'immagine è su disco).
export function VideoHistoryPanel({ video, onChange }) {
  const [busy, setBusy] = useState(null);
  const entries = video.metadataHistory ?? [];

  async function restore(e) {
    setBusy(e.id);
    try {
      onChange(await restoreHistory(video.id, e.id));
      showToast('Versione ripristinata.', 'success', 2500);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="history-panel">
      <div className="history-head"><History size={16} />Cronologia dei metadati</div>
      {entries.map((e) => (
        <div key={e.id} className="history-entry">
          <div className="history-line">
            <b>{entryTitle(e)}</b>
            <span>{dateIt(e.at, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </div>
          <div className="hint">{ORIGIN_TEXT[e.origin] ?? e.origin}{e.label ? ` · ${e.label}` : ''}</div>
          {e.field === 'thumbnail' ? (
            <div className="history-thumbs">
              {e.from?.url ? <img src={e.from.url} alt="prima" /> : <span className="compare-empty">nessuna</span>}
              {e.to?.url && <img src={e.to.url} alt="dopo" />}
            </div>
          ) : (
            <div className="hint discreet-text">era: «{short(e.from)}»</div>
          )}
          <button className="history-restore" disabled={busy === e.id} onClick={() => restore(e)}>
            <Undo2 size={13} />{e.origin === 'kept' ? 'Usa la copertina nuova' : 'Ripristina questa versione'}
          </button>
        </div>
      ))}
      <div className="history-entry">
        <div className="history-line">
          <b>Prima acquisizione</b>
          <span>{dateIt(video.addedAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        </div>
        <div className="hint discreet-text">{video.sources?.length ? `fonte ${video.sources.map((s) => s.name ?? s.sourceId).join(', ')}` : 'link diretto'}</div>
      </div>
    </div>
  );
}
