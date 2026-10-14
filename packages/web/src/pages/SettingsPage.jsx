import { useEffect, useState } from 'react';
import {
  Download, Upload, Cookie, Trash2, PictureInPicture2, Play, Gauge, Layers, EyeOff, CircleSlash,
  Shield, Library, Archive, Monitor, Server, ChevronDown, ChevronRight
} from 'lucide-react';
import { BACKUP_URL, restoreBackup, getConfig, setDefaultQuality, setParallel, uploadCookies, deleteCookies, listIgnored, unignoreVideo } from '../api/client.js';
import { useTitle } from '../hooks/useTitle.js';
import { confirmDialog } from '../lib/dialog.js';
import { showToast } from '../lib/toast.js';
import { useMiniPlayerEnabled, setMiniPlayerEnabled, useAutoplayOnOpen, setAutoplayOnOpen } from '../lib/playerStore.js';
import { useDiscreet, setDiscreetMode } from '../lib/discreetStore.js';
import { useShowHiddenFilter, setShowHiddenFilter } from '../lib/hiddenFilterStore.js';

// Impostazioni in una pagina sola, divisa in quattro gruppi. Ogni gruppo dice
// dove vale: «Questo browser» (preferenze in localStorage) o «Server» (per
// tutti i dispositivi e per la CLI). Descrizioni di una riga: il dettaglio
// che serve davvero sta nel testo, il resto si scopre usando.
const GROUPS = [
  { id: 'riproduzione', title: 'Riproduzione', icon: Play, scope: 'browser' },
  { id: 'privacy', title: 'Privacy', icon: Shield, scope: 'browser' },
  { id: 'download', title: 'Download', icon: Download, scope: 'server' },
  { id: 'libreria', title: 'Libreria', icon: Library, scope: 'server' }
];

const DISCREET_OPTIONS = [
  { value: 'off', title: 'Spenta', sub: 'Copertine, foto e testi visibili come sempre.' },
  { value: 'images', title: 'Immagini', sub: 'Copertine, foto profilo e immagine del player sfocate. Nel player, «Mostra» la scopre per il solo video corrente.' },
  { value: 'all', title: 'Immagini e testi', sub: 'In più sfoca titoli, nomi, descrizioni, tag e notifiche. La scheda del browser resta «Ondo».' }
];

function Scope({ scope }) {
  return scope === 'server'
    ? <span className="set-scope" title="Vale per tutti i dispositivi e per la CLI"><Server size={12} />Server</span>
    : <span className="set-scope" title="Salvata in questo browser: gli altri dispositivi non cambiano"><Monitor size={12} />Questo browser</span>;
}

function Group({ id, title, icon: Icon, scope, children }) {
  return (
    <section className="set-group" id={`set-${id}`} aria-labelledby={`set-${id}-title`}>
      <div className="set-group-head">
        <Icon size={17} className="set-group-icon" />
        <h2 id={`set-${id}-title`}>{title}</h2>
        <Scope scope={scope} />
      </div>
      <div className="set-card">{children}</div>
    </section>
  );
}

// Una riga: titolo e descrizione a sinistra, controllo a destra (sotto con
// `stack`). `children` va a tutta larghezza sotto la riga: errori, esiti,
// elenchi.
function Row({ icon: Icon, title, sub, control, stack, children }) {
  return (
    <div className={`set-row${stack ? ' set-row--stack' : ''}`}>
      <div className="set-row-text">
        <div className="set-row-title">{Icon && <Icon size={15} />}{title}</div>
        {sub && <div className="set-row-sub">{sub}</div>}
      </div>
      {control && <div className="set-row-ctl">{control}</div>}
      {children && <div className="set-row-extra">{children}</div>}
    </div>
  );
}

function Switch({ on, onToggle, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`switch${on ? ' on' : ''}`} onClick={onToggle} aria-label={label}>
      <span className="switch-knob" />
    </button>
  );
}

export function SettingsPage() {
  useTitle('Impostazioni');

  const miniPlayerEnabled = useMiniPlayerEnabled();
  const autoplayOnOpen = useAutoplayOnOpen();
  const { mode: discreetMode } = useDiscreet();
  const showHidden = useShowHiddenFilter();

  // --- Backup / ripristino ---
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // --- Qualità predefinita e download in parallelo (stessi menu della CLI) ---
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [qualityError, setQualityError] = useState(null);
  const [parallelBusy, setParallelBusy] = useState(false);
  const [parallelError, setParallelError] = useState(null);

  // --- Cookie YouTube ---
  const [cookiesStatus, setCookiesStatus] = useState(null);
  const [cookiesBusy, setCookiesBusy] = useState(false);
  const [cookiesError, setCookiesError] = useState(null);

  function reloadConfig() {
    return getConfig().then((c) => {
      setConfig(c);
      setCookiesStatus(c.cookies);
      return c;
    });
  }

  useEffect(() => {
    reloadConfig().catch((e) => setConfigError(e.message));
  }, []);

  async function handleRestore(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permette di riselezionare lo stesso file
    if (!file) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await restoreBackup(file));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetQuality(e) {
    const level = (config?.qualityLevels ?? []).find((q) => e.target.value === `${q.kind}:${q.height}`);
    if (!level) return;
    setQualityError(null);
    setQualityBusy(true);
    try {
      await setDefaultQuality(level);
      await reloadConfig();
    } catch (err) {
      setQualityError(err.message);
    } finally {
      setQualityBusy(false);
    }
  }

  async function handleSetParallel(e) {
    const n = Number.parseInt(e.target.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    setParallelError(null);
    setParallelBusy(true);
    try {
      await setParallel(n);
      await reloadConfig();
    } catch (err) {
      setParallelError(err.message);
    } finally {
      setParallelBusy(false);
    }
  }

  async function handleUploadCookies(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permette di riselezionare lo stesso file
    if (!file) return;
    setCookiesError(null);
    setCookiesBusy(true);
    try {
      const text = await file.text();
      const status = await uploadCookies(text);
      setCookiesStatus(status);
      showToast('Cookie caricati.', 'success');
    } catch (err) {
      setCookiesError(err.message);
      showToast(`Caricamento cookie fallito: ${err.message}`, 'error');
    } finally {
      setCookiesBusy(false);
    }
  }

  async function handleDeleteCookies() {
    const ok = await confirmDialog({
      title: 'Cancellare i cookie?',
      message: 'I video privati, non listati o con limite d\'età smetteranno di essere accessibili finché non ne carichi di nuovi.',
      confirmLabel: 'Cancella',
      danger: true
    });
    if (!ok) return;
    setCookiesError(null);
    setCookiesBusy(true);
    try {
      const status = await deleteCookies();
      setCookiesStatus(status);
      showToast('Cookie cancellati.', 'success');
    } catch (err) {
      setCookiesError(err.message);
      showToast(`Cancellazione cookie fallita: ${err.message}`, 'error');
    } finally {
      setCookiesBusy(false);
    }
  }

  const currentQuality = (config?.qualityLevels ?? []).find((q) => q.current);
  const discreetSub = DISCREET_OPTIONS.find((o) => o.value === discreetMode)?.sub;

  return (
    <>
      <div className="page-head"><h1>Impostazioni</h1></div>

      <nav className="set-jump" aria-label="Vai al gruppo">
        {GROUPS.map(({ id, title, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="set-chip"
            onClick={() => document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            <Icon size={13} />{title}
          </button>
        ))}
      </nav>

      {configError && <div className="notice error">{configError}</div>}

      <div className="set-groups">
        <Group {...GROUPS[0]}>
          <Row
            icon={PictureInPicture2}
            title="Mini-player flottante"
            sub="Lasciando un video in riproduzione, continua in un riquadro in basso a destra. Spento, nel player compare il Picture-in-Picture. Solo desktop."
            control={<Switch on={miniPlayerEnabled} onToggle={() => setMiniPlayerEnabled(!miniPlayerEnabled)} label="Mini-player flottante" />}
          />
          <Row
            icon={Play}
            title="Riproduzione automatica"
            sub="Aprendo un video scaricato parte da solo (se il browser lo consente). La coda prosegue comunque."
            control={<Switch on={autoplayOnOpen} onToggle={() => setAutoplayOnOpen(!autoplayOnOpen)} label="Riproduzione automatica" />}
          />
        </Group>

        <Group {...GROUPS[1]}>
          <Row
            stack
            icon={EyeOff}
            title="Modalità discreta"
            sub="Per usare Ondo quando qualcuno vede lo schermo. Tieni premuto Alt (⌥) e passa sopra un elemento per scoprirlo al volo."
            control={
              <div className="set-segmented" role="radiogroup" aria-label="Modalità discreta">
                {DISCREET_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={discreetMode === o.value}
                    className={discreetMode === o.value ? 'active' : ''}
                    onClick={() => setDiscreetMode(o.value)}
                  >
                    {o.title}
                  </button>
                ))}
              </div>
            }
          >
            {discreetSub && <div className="hint">{discreetSub}</div>}
          </Row>
          <Row
            icon={EyeOff}
            title="Filtro «Nascosti»"
            sub="Mostra il filtro nella Libreria e nei creator. Spento, i video nascosti non compaiono da nessuna parte (restano in libreria, con i loro file)."
            control={<Switch on={showHidden} onToggle={() => setShowHiddenFilter(!showHidden)} label="Filtro Nascosti" />}
          />
        </Group>

        <Group {...GROUPS[2]}>
          <Row
            icon={Gauge}
            title="Qualità predefinita"
            sub="Per i download futuri. «Chiedi ogni volta» fa scegliere la risoluzione a ogni download. L'AV1 è sempre escluso."
            control={config && (
              <select
                className="set-select"
                aria-label="Qualità predefinita"
                value={currentQuality ? `${currentQuality.kind}:${currentQuality.height}` : ''}
                onChange={handleSetQuality}
                disabled={qualityBusy}
              >
                {(config.qualityLevels ?? []).map((q) => (
                  <option key={`${q.kind}:${q.height}`} value={`${q.kind}:${q.height}`}>{q.label}</option>
                ))}
              </select>
            )}
          >
            {qualityError && <div className="notice error">{qualityError}</div>}
          </Row>
          <Row
            icon={Layers}
            title="Download in parallelo"
            sub="Alzarlo fa partire subito quelli in coda; abbassarlo non interrompe quelli in corso."
            control={config && (
              <select className="set-select" aria-label="Download in parallelo" value={config.parallel ?? 1} onChange={handleSetParallel} disabled={parallelBusy}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>{n === 1 ? '1 — uno alla volta' : n}</option>
                ))}
              </select>
            )}
          >
            {parallelError && <div className="notice error">{parallelError}</div>}
          </Row>
          <Row
            icon={Cookie}
            title="Cookie YouTube"
            sub={<>
              Per video privati, non listati o con limite d'età: esportali dal browser in cui sei loggato (es. «Get cookies.txt»). Mai nel backup.{' '}
              {cookiesStatus && (cookiesStatus.present
                ? <>Caricati il {new Date(cookiesStatus.updatedAt).toLocaleString('it-IT')}.</>
                : <>Nessun cookie caricato.</>)}
            </>}
            control={<>
              <label className="btn small" style={{ cursor: cookiesBusy ? 'default' : 'pointer' }}>
                <Upload size={14} /> {cookiesBusy ? 'Caricamento…' : cookiesStatus?.present ? 'Sostituisci…' : 'Carica…'}
                <input type="file" accept=".txt" hidden onChange={handleUploadCookies} disabled={cookiesBusy} />
              </label>
              {cookiesStatus?.present && (
                <button className="btn small btn-danger" onClick={handleDeleteCookies} disabled={cookiesBusy}>
                  <Trash2 size={14} /> Cancella
                </button>
              )}
            </>}
          >
            {cookiesError && <div className="notice error">{cookiesError}</div>}
          </Row>
        </Group>

        <Group {...GROUPS[3]}>
          <Row
            icon={Archive}
            title="Backup"
            sub="Catalogo, metadati, impostazioni e copertine in un .zip (senza video e cookie). Ripristinando, i dati attuali vengono prima messi da parte; poi va riavviato il server."
            control={<>
              <a className="btn small btn-primary" href={BACKUP_URL}><Download size={14} /> Scarica backup</a>
              <label className="btn small" style={{ cursor: busy ? 'default' : 'pointer' }}>
                <Upload size={14} /> {busy ? 'Ripristino…' : 'Ripristina…'}
                <input type="file" accept=".zip" hidden onChange={handleRestore} disabled={busy} />
              </label>
            </>}
          >
            {error && <div className="notice error">{error}</div>}
            {result && (
              <div className="notice success">
                Ripristinati: {result.restored.join(', ')}{result.restoredImages ? ` + ${result.restoredImages} immagini` : ''}. Copia di sicurezza in <code>{result.safetyDir}</code>.
                {' '}<strong>Riavvia il server</strong> per applicare le modifiche.
              </div>
            )}
          </Row>
          <IgnoredRow />
        </Group>
      </div>
    </>
  );
}

// I video ignorati sono già cancellati dalla libreria: di loro resta solo
// quanto serve a non riprenderli. «Sblocca» li toglie dall'elenco, e al
// prossimo controllo della fonte rientrano da riscaricare, se ci sono ancora.
function IgnoredRow() {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { listIgnored().then(setList).catch(() => setList([])); }, []);
  async function restore(x) {
    const ok = await confirmDialog({
      title: 'Sbloccare il video?',
      message: `"${x.title ?? x.id}" tornerà in libreria al prossimo controllo della sua fonte, come un video nuovo da scaricare. Il file era stato cancellato: va riscaricato, e non sempre si può (se nel frattempo è sparito da YouTube o dalla playlist non tornerà).`,
      confirmLabel: 'Sblocca'
    });
    if (!ok) return;
    try {
      setList(await unignoreVideo(x.id));
      showToast('Sbloccato: rientra al prossimo controllo della fonte.', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }
  const n = list?.length ?? 0;
  return (
    <Row
      icon={CircleSlash}
      title="Video ignorati"
      sub={list === null ? 'Cancellati dalla libreria e mai più ripresi dalle fonti.'
        : n === 0 ? 'Nessuno. Un video ignorato viene cancellato e non viene più ripreso dalle fonti.'
        : `${n} video, cancellati e mai più ripresi dalle fonti. Sbloccandone uno, rientra al prossimo controllo della fonte.`}
      control={n > 0 && (
        <button type="button" className="btn small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {open ? 'Chiudi' : 'Gestisci'}
        </button>
      )}
    >
      {open && n > 0 && (
        <div className="ignored-list">
          {list.map((x) => (
            <div key={x.id} className="ignored-row">
              <div className="ignored-text">
                <b className="discreet-text">{x.title ?? x.id}</b>
                <span className="discreet-text">{[x.channelName, new Date(x.at).toLocaleDateString('it-IT')].filter(Boolean).join(' · ')}</span>
              </div>
              <button className="btn small" onClick={() => restore(x)}>Sblocca</button>
            </div>
          ))}
        </div>
      )}
    </Row>
  );
}
