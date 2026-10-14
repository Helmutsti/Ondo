import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { WandSparkles, X, Check, Clock, Lock, LockOpen, CircleCheck, CircleX, ArrowRight, TriangleAlert } from 'lucide-react';
import { startMetadataUpdate, listMetadataReviews, resolveMetadataReview } from '../api/client.js';
import { useMetadataWizard, closeMetadataWizard, FIELD_LABEL } from '../lib/metadataWizard.js';
import { useActivity, refreshActivity } from '../lib/activityStore.js';
import { sized, SMALL } from '../lib/images.js';
import { showToast } from '../lib/toast.js';

const STEPS = ['Cosa aggiornare', 'Regole', 'Recupero', 'Revisione'];
const META_FIELDS = ['title', 'description', 'tags', 'thumbnail', 'chapters', 'uploadDate', 'durationSeconds'];
const FIELD_HINT = {
  title: 'può cambiare nel tempo',
  description: 'link, testo',
  tags: 'parole chiave',
  thumbnail: 'immagine in alta risoluzione',
  chapters: 'se presenti',
  uploadDate: 'raramente cambia',
  durationSeconds: 'raramente cambia',
  presence: 'verifica se è ancora online'
};
const DEFAULT_FIELDS = ['title', 'description', 'tags', 'thumbnail', 'presence'];
const DEFAULT_RULES = { title: 'ask', description: 'fill', tags: 'overwrite', thumbnail: 'ask', chapters: 'fill', uploadDate: 'fill', durationSeconds: 'fill' };
const RULE_OPTIONS = [
  { value: 'fill', label: 'Riempi solo i vuoti' },
  { value: 'overwrite', label: 'Sovrascrivi' },
  { value: 'ask', label: 'Chiedimi se diverso' }
];
const RULE_HINT = {
  fill: { title: 'Si tiene quello salvato, se c\'è', description: 'Si tiene quella salvata, se c\'è', tags: 'Solo dove mancano', thumbnail: 'Solo dove manca', default: 'Solo dove manca' },
  overwrite: { thumbnail: 'La vecchia resta nello storico', tags: 'Sostituiti dai nuovi', default: 'Il valore di YouTube sostituisce quello salvato' },
  ask: { title: 'Se cambia, vuoi vederlo prima', thumbnail: 'Se cambia, le confronti affiancate', default: 'Se cambia, decidi tu in revisione' }
};
const RULES_KEY = 'ondo:metadataRules';
const SIX_MONTHS = 182 * 24 * 3_600_000;
const SECONDS_PER_VIDEO = 4;

function loadRules() {
  try { return { ...DEFAULT_RULES, ...JSON.parse(localStorage.getItem(RULES_KEY) ?? '{}') }; } catch { return { ...DEFAULT_RULES }; }
}

const SCOPES = [
  { value: 'all', label: (o) => o.allLabel ?? 'Tutti', fn: () => true },
  { value: 'never', label: () => 'Mai aggiornati', fn: (v) => !v.enrichedAt },
  { value: 'old', label: () => 'Non aggiornati da 6 mesi', fn: (v) => !v.enrichedAt || Date.now() - Date.parse(v.enrichedAt) > SIX_MONTHS },
  { value: 'errors', label: () => 'Con errori di recupero', fn: (v) => !!v.enrichError },
  { value: 'downloaded', label: () => 'Solo scaricati', fn: (v) => v.download === 'downloaded' }
];

function fmtMinutes(seconds) {
  if (seconds < 60) return 'meno di un minuto';
  const m = Math.round(seconds / 60);
  return m === 1 ? 'circa 1 minuto' : `circa ${m} minuti`;
}

// Host del wizard: montato una volta nel layout, si apre con openMetadataWizard.
export function MetadataWizardHost() {
  const opts = useMetadataWizard();
  if (!opts) return null;
  return <MetadataWizard key={opts.key} opts={opts} />;
}

function MetadataWizard({ opts }) {
  const videos = opts.videos ?? [];
  const [step, setStep] = useState(opts.step === 'review' ? 3 : 0);
  const [scope, setScope] = useState('all');
  const [fields, setFields] = useState(() => new Set(DEFAULT_FIELDS));
  const [rules, setRules] = useState(loadRules);
  const [saveDefaults, setSaveDefaults] = useState(false);
  const [jobId, setJobId] = useState(opts.jobId ?? null);
  const [error, setError] = useState(null);
  const par = useActivity()?.pool?.metadataParallel ?? 2;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeMetadataWizard(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const scopeDef = SCOPES.find((s) => s.value === scope);
  const scoped = useMemo(() => videos.filter(scopeDef.fn), [videos, scopeDef]);
  const metaChosen = META_FIELDS.filter((f) => fields.has(f));
  const onlyPresence = metaChosen.length === 0 && fields.has('presence');

  function toggleField(f) {
    setFields((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  }

  async function start() {
    setError(null);
    if (saveDefaults) {
      try { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); } catch { /* solo per questa volta */ }
    }
    try {
      const { jobId: id } = await startMetadataUpdate({
        videoIds: scoped.map((v) => v.id),
        fields: [...fields],
        rules,
        label: opts.label ?? null
      });
      setJobId(id);
      setStep(2);
      refreshActivity();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="modal-overlay wizard-overlay" onClick={closeMetadataWizard}>
      <div className="wizard" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Aggiorna metadati">
        <div className="wizard-head">
          <WandSparkles size={20} className="wizard-icon" />
          <div className="wizard-title">
            <h3>Aggiorna metadati</h3>
            <div className="page-sub discreet-text">
              {opts.label ?? 'Revisione'}{videos.length ? ` · ${videos.length} video` : ''}
            </div>
          </div>
          <button className="bulk-close" onClick={closeMetadataWizard} aria-label="Chiudi"><X size={18} /></button>
        </div>
        <div className="stepper">
          {STEPS.map((label, i) => (
            <div key={label} className={`step${i === step ? ' current' : ''}${i < step ? ' done' : ''}`}>
              <span className="step-dot">{i < step ? <Check size={13} /> : i + 1}</span>
              <span className="step-label">{label}</span>
              {i < STEPS.length - 1 && <span className="step-line" />}
            </div>
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="wizard-body">
              <div className="section-label">Quali video</div>
              <div className="chips wrap">
                {SCOPES.map((s) => {
                  const n = videos.filter(s.fn).length;
                  if (s.value !== 'all' && n === 0) return null;
                  return (
                    <div key={s.value} className={`chip${scope === s.value ? ' active' : ''}`} onClick={() => setScope(s.value)}>
                      {s.label(opts)}<span className="count">{n}</span>
                    </div>
                  );
                })}
              </div>
              <div className="section-label" style={{ marginTop: 22 }}>Quali campi</div>
              <div className="field-grid">
                {[...META_FIELDS, 'presence'].map((f) => (
                  <label key={f} className={`field-option${fields.has(f) ? ' on' : ''}`}>
                    <input type="checkbox" checked={fields.has(f)} onChange={() => toggleField(f)} />
                    <span>
                      <b>{FIELD_LABEL[f]}</b>
                      <small>{FIELD_HINT[f]}</small>
                    </span>
                  </label>
                ))}
              </div>
              <div className="wizard-note">
                <Clock size={15} />
                {scoped.length} richieste a YouTube{onlyPresence ? ' (leggere: solo la verifica)' : ''} · {fmtMinutes((scoped.length * (onlyPresence ? 2 : SECONDS_PER_VIDEO)) / par)} con {par} in parallelo. Puoi chiudere la finestra: continua in Attività.
              </div>
            </div>
            <div className="wizard-foot">
              <span className="hint">{fields.size} camp{fields.size === 1 ? 'o' : 'i'} su {scoped.length} video</span>
              <button className="btn" onClick={closeMetadataWizard}>Annulla</button>
              <button className="btn btn-primary" disabled={!scoped.length || !fields.size} onClick={() => (onlyPresence ? start() : setStep(1))}>
                {onlyPresence ? <><WandSparkles size={14} />Avvia verifica</> : 'Avanti'}
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="wizard-body">
              <p className="wizard-intro">Per ogni campo decidi cosa succede se il valore su YouTube è diverso da quello salvato. I campi bloccati non vengono mai toccati.</p>
              {metaChosen.map((f) => {
                const lockedOn = scoped.filter((v) => (v.locks ?? []).includes(f)).length;
                const hint = RULE_HINT[rules[f]]?.[f] ?? RULE_HINT[rules[f]]?.default;
                return (
                  <div key={f} className="rule-row">
                    <Check size={16} className="rule-check" />
                    <div className="rule-text">
                      <b>{FIELD_LABEL[f]}</b>
                      {lockedOn > 0
                        ? <small className="warn">Bloccat{f === 'tags' || f === 'chapters' ? 'i' : 'a'} su {lockedOn} video: non verrà toccat{f === 'tags' || f === 'chapters' ? 'i' : 'a'} lì</small>
                        : <small>{hint}</small>}
                    </div>
                    {lockedOn > 0 && <Lock size={15} className="rule-lock" />}
                    <div className="seg-text compact" role="radiogroup" aria-label={`Regola per ${FIELD_LABEL[f]}`}>
                      {RULE_OPTIONS.map((o) => (
                        <button key={o.value} type="button" role="radio" aria-checked={rules[f] === o.value} className={rules[f] === o.value ? 'on' : ''} onClick={() => setRules((r) => ({ ...r, [f]: o.value }))}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {fields.has('presence') && (
                <div className="rule-row muted">
                  <CircleCheck size={16} className="rule-check ok" />
                  <div className="rule-text">
                    <b>Presenza su YouTube</b>
                    <small>Sempre applicata: se il video risulta privato o cancellato viene segnato «Sparito»; se ricompare torna disponibile.</small>
                  </div>
                </div>
              )}
              <div className="wizard-guarantee"><Check size={15} />Regola fissa: un campo pieno non viene MAI sostituito da uno vuoto o da «Private video», qualunque scelta tu faccia.</div>
              <label className="check-line">
                <input type="checkbox" checked={saveDefaults} onChange={(e) => setSaveDefaults(e.target.checked)} />
                Usa queste regole come predefinite (in questo browser)
              </label>
              {error && <div className="notice error">{error}</div>}
            </div>
            <div className="wizard-foot">
              <span className="hint">Le scelte «Chiedimi» finiscono in revisione</span>
              <button className="btn" onClick={() => setStep(0)}>Indietro</button>
              <button className="btn btn-primary" onClick={start}><WandSparkles size={14} />Avvia recupero</button>
            </div>
          </>
        )}

        {step === 2 && <ProgressStep jobId={jobId} onReview={() => setStep(3)} />}
        {step === 3 && <ReviewStep scopeIds={opts.videos ? new Set(videos.map((v) => v.id)) : null} label={opts.label} />}
      </div>
    </div>
  );
}

const OUTCOME_ICON = { updated: CircleCheck, unchanged: CircleCheck, review: WandSparkles, removed: TriangleAlert, restricted: Lock, error: CircleX };

function ProgressStep({ jobId, onReview }) {
  const activity = useActivity();
  const par = activity?.pool?.metadataParallel ?? 2;
  const job = [...(activity?.active ?? []), ...(activity?.finished ?? [])].find((j) => j.id === jobId);
  const counts = job?.note?.counts ?? { total: 0, done: 0 };
  const recent = job?.note?.recent ?? [];
  const finished = job && (job.status === 'success' || job.status === 'failed');
  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  const left = counts.total - counts.done;

  return (
    <>
      <div className="wizard-body">
        <div className="progress-card">
          {job?.note?.pausedUntil && (
            <div className="act-warning" style={{ marginBottom: 14 }}>
              <TriangleAlert size={16} />
              <div><b>In pausa</b><span>{job.note.pauseHint ?? 'YouTube sta bloccando le richieste.'} Riprendo da solo alle {new Date(job.note.pausedUntil).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}.</span></div>
              <Link to="/settings" className="btn small" onClick={closeMetadataWizard}>Cookie…</Link>
            </div>
          )}
          <div className="progress-big">
            <b>{counts.done} di {counts.total}</b>
            <span>{finished ? (job.status === 'failed' ? ' · interrotto' : ' · finito') : left > 0 ? ` · ${fmtMinutes((left * SECONDS_PER_VIDEO) / par)} rimanenti · ${par} in parallelo` : ' · avvio…'}</span>
          </div>
          <div className={`progress-bar${!job || (!finished && counts.done === 0) ? ' indeterminate' : ''}`} style={{ height: 8 }}>
            <div style={job && (finished || counts.done > 0) ? { width: `${pct}%` } : undefined}></div>
          </div>
          <div className="progress-counts">
            <span><b>{counts.updated ?? 0}</b>aggiornati</span>
            <span><b>{counts.unchanged ?? 0}</b>invariati</span>
            <span className={counts.review ? 'accent' : ''}><b>{counts.review ?? 0}</b>da rivedere</span>
            <span><b>{counts.removed ?? 0}</b>spariti</span>
            <span className={counts.error ? 'err' : ''}><b>{counts.error ?? 0}</b>errori</span>
          </div>
        </div>
        {job?.status === 'failed' && (
          <div className="act-warning" style={{ marginTop: 14 }}>
            <TriangleAlert size={16} />
            <div><b>Recupero interrotto</b><span>{job.error?.hint ?? job.error?.message} I video non ancora elaborati restano com'erano.</span></div>
            {job.error?.category === 'blocked' && <Link to="/settings" className="btn small" onClick={closeMetadataWizard}>Cookie…</Link>}
          </div>
        )}
        {recent.length > 0 && <div className="section-label" style={{ marginTop: 18 }}>Ultimi elaborati</div>}
        <div className="recent-list">
          {recent.map((r) => {
            const Icon = OUTCOME_ICON[r.outcome] ?? CircleCheck;
            return (
              <div key={r.id} className={`recent-row ${r.outcome}`}>
                <Icon size={15} />
                <span className="recent-title discreet-text">{r.title}</span>
                <span className="recent-detail">{r.detail}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="wizard-foot">
        <span className="hint">{finished ? 'Le revisioni restano anche in Attività › Da rivedere.' : 'Puoi chiudere: il lavoro continua in Attività.'}</span>
        <button className="btn" onClick={closeMetadataWizard}>{finished ? 'Chiudi' : 'Continua in background'}</button>
        {finished && counts.review > 0 && (
          <button className="btn btn-primary" onClick={onReview}><ArrowRight size={14} />Rivedi ({counts.review})</button>
        )}
      </div>
    </>
  );
}

function fieldText(field, value) {
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return field === 'chapters' ? value.map((c) => c.title).join(' · ') : value.join(', ');
  if (field === 'durationSeconds') return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  return String(value);
}

function ReviewStep({ scopeIds, label }) {
  const [items, setItems] = useState(null);
  const [index, setIndex] = useState(0);
  const [choices, setChoices] = useState({});
  const [locks, setLocks] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const all = await listMetadataReviews();
      const list = scopeIds ? all.filter((v) => scopeIds.has(v.id)) : all;
      setItems(list);
      setIndex((i) => Math.min(i, Math.max(0, list.length - 1)));
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  const video = items?.[index];
  const fields = video ? Object.entries(video.pendingReview.fields) : [];
  const choiceFor = (f) => choices[`${video.id}:${f}`] ?? 'incoming';

  async function apply(v, picked, lock = []) {
    await resolveMetadataReview(v.id, picked, lock);
  }

  async function applyCurrent() {
    setBusy(true);
    setError(null);
    try {
      const picked = Object.fromEntries(fields.map(([f]) => [f, choiceFor(f)]));
      const lock = fields.map(([f]) => f).filter((f) => locks[`${video.id}:${f}`]);
      await apply(video, picked, lock);
      const rest = items.filter((x) => x.id !== video.id);
      setItems(rest);
      setIndex((i) => Math.min(i, Math.max(0, rest.length - 1)));
      if (!rest.length) showToast('Revisione completata.', 'success');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyAll(which) {
    setBusy(true);
    setError(null);
    try {
      for (const v of items) {
        await apply(v, Object.fromEntries(Object.keys(v.pendingReview.fields).map((f) => [f, which])));
      }
      showToast(which === 'incoming' ? `Applicati i valori nuovi su ${items.length} video.` : `Tenuti i valori attuali su ${items.length} video.`, 'success');
      setItems([]);
    } catch (e) {
      setError(e.message);
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!items) return <div className="wizard-body"><div className="empty-state"><span className="spinner"></span></div></div>;
  if (!items.length) {
    return (
      <>
        <div className="wizard-body"><div className="empty-state">Niente da rivedere{label ? ` per «${label}»` : ''}.</div></div>
        <div className="wizard-foot"><span className="hint" /><button className="btn btn-primary" onClick={closeMetadataWizard}>Chiudi</button></div>
      </>
    );
  }

  return (
    <>
      <div className="wizard-body review">
        <div className="review-list">
          <div className="section-label">{items.length} video da rivedere</div>
          {items.map((v, i) => (
            <button key={v.id} type="button" className={`review-item${i === index ? ' on' : ''}`} onClick={() => setIndex(i)}>
              <span className="review-thumb">{v.thumbnailUrl && <img src={sized(v.thumbnailUrl, SMALL)} alt="" />}</span>
              <span className="review-item-text">
                <b className="discreet-text">{v.title}</b>
                <small>{Object.keys(v.pendingReview.fields).map((f) => FIELD_LABEL[f].toLowerCase()).join(' · ')}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="review-compare">
          <div className="review-head discreet-text">{video.title} · {video.channel?.name ?? ''}</div>
          {fields.map(([f, r]) => {
            const lk = `${video.id}:${f}`;
            return (
              <div key={f} className="compare-row">
                <div className="compare-label">
                  <b>{FIELD_LABEL[f]}</b>
                  <small>{f === 'thumbnail' ? 'diversa' : 'diverso'}</small>
                </div>
                {['current', 'incoming'].map((side) => (
                  <button
                    key={side}
                    type="button"
                    className={`compare-card${choiceFor(f) === side ? ' on' : ''}`}
                    onClick={() => setChoices((c) => ({ ...c, [lk]: side }))}
                    role="radio"
                    aria-checked={choiceFor(f) === side}
                  >
                    <span className="compare-cap"><span className="radio-dot" />{side === 'current' ? 'Attuale' : 'Da YouTube'}</span>
                    {f === 'thumbnail'
                      ? (r[side]?.url ? <img src={r[side].url} alt="" /> : <span className="compare-empty">nessuna</span>)
                      : <span className="compare-text discreet-text">{fieldText(f, r[side])}</span>}
                  </button>
                ))}
                <button
                  type="button"
                  className={`compare-lock${locks[lk] ? ' on' : ''}`}
                  title={locks[lk] ? 'Verrà bloccato: i prossimi aggiornamenti non lo toccano' : 'Blocca questo campo'}
                  aria-label="Blocca il campo"
                  onClick={() => setLocks((l) => ({ ...l, [lk]: !l[lk] }))}
                >
                  {locks[lk] ? <Lock size={15} /> : <LockOpen size={15} />}
                </button>
              </div>
            );
          })}
          {error && <div className="notice error">{error}</div>}
        </div>
      </div>
      <div className="wizard-foot">
        <span className="hint">Video {index + 1} di {items.length}</span>
        <button className="btn" disabled={busy} onClick={() => applyAll('current')}>Tieni tutti gli attuali</button>
        <button className="btn" disabled={busy} onClick={() => applyAll('incoming')}>Applica tutti i nuovi</button>
        <button className="btn btn-primary" disabled={busy} onClick={applyCurrent}><ArrowRight size={14} />Applica e vai al prossimo</button>
      </div>
    </>
  );
}
