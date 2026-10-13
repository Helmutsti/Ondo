// Classificazione degli errori di yt-dlp (e di quelli nostri attorno a yt-dlp).
//
// Perché esiste: prima un solo test — /private video|video unavailable/ —
// decideva se un video era "rimosso". Ma "Video unavailable" compare anche nei
// blocchi per paese e nel messaggio con cui YouTube rallenta le richieste
// ("This content isn't available, try again later"): un rallentamento poteva
// segnare come rimossi video che esistono. Ora ogni errore ha una categoria, e
// lo stato di presenza cambia SOLO per le categorie che lo dicono davvero.
//
// L'ordine delle regole conta: la prima che corrisponde vince. I messaggi sono
// quelli tipici di yt-dlp; quando ne compare uno che nessuna regola riconosce
// finisce in UNKNOWN, che per scelta non cambia mai lo stato di un video.

export const ERROR_CATEGORY = Object.freeze({
  // Definitivi: il video non c'è più su YouTube.
  REMOVED: 'removed',
  PRIVATE: 'private',
  // "Video unavailable" senza altra spiegazione: di solito un video cancellato,
  // ma non abbastanza certo da agire alla prima — serve una conferma ripetuta.
  UNAVAILABLE: 'unavailable',
  // Il video esiste ma non è accessibile così (età, membri, paese, premiere).
  RESTRICTED: 'restricted',
  // YouTube sta bloccando o rallentando NOI, non quel video: va fermata la coda.
  BLOCKED: 'blocked',
  // Il video c'è, è il download a non riuscire (formati, 403 sui frammenti).
  FORMAT: 'format',
  // Rete o server di YouTube momentaneamente giù: si riprova più tardi.
  NETWORK: 'network',
  // Problema di Ondo o della macchina (yt-dlp vecchio, disco pieno, permessi).
  ENVIRONMENT: 'environment',
  // Errore nostro attorno a yt-dlp (file metadati illeggibile o sparito).
  INTERNAL: 'internal',
  UNKNOWN: 'unknown'
});

const C = ERROR_CATEGORY;

// { category, reason, test, hint }. `hint` è il testo per chi usa l'app: dice
// cosa è successo e, quando c'è, cosa fare.
const RULES = [
  // --- Blocchi di YouTube: prima di tutto, perché alcuni iniziano con
  // "Video unavailable" e non devono mai finire tra i rimossi.
  { category: C.BLOCKED, reason: 'bot-check', test: /confirm you(?:'|’)?re not a bot/i,
    hint: 'YouTube chiede di confermare che non sei un bot: riprova più tardi o carica cookie aggiornati.' },
  { category: C.BLOCKED, reason: 'rate-limit', test: /content isn(?:'|’)?t available,? try again later|http error 429|too many requests|rate[- ]?limit/i,
    hint: 'YouTube sta limitando le richieste: riprova più tardi.' },

  // --- Ambiente: niente da fare sul singolo video finché non si sistema la macchina.
  { category: C.ENVIRONMENT, reason: 'disk-full', test: /no space left on device|enospc/i,
    hint: 'Disco pieno: libera spazio e riprova.' },
  { category: C.ENVIRONMENT, reason: 'outdated', test: /(nsig|signature|n challenge)[^\n]*(extraction|solving)?[^\n]*fail|please update yt-dlp|update to the latest version|confirm you are on the latest version/i,
    hint: 'yt-dlp non riesce più a leggere YouTube: va aggiornato.' },
  { category: C.ENVIRONMENT, reason: 'js-runtime', test: /javascript runtime/i,
    hint: 'Manca il runtime JavaScript che yt-dlp usa per YouTube.' },
  { category: C.ENVIRONMENT, reason: 'permissions', test: /permission denied|eacces|eperm/i,
    hint: 'Permessi insufficienti sulla cartella della libreria.' },
  { category: C.ENVIRONMENT, reason: 'missing-binary', test: /spawn \S+ enoent/i,
    hint: 'yt-dlp o ffmpeg non trovati.' },

  // --- Privato: prima delle restrizioni, perché il messaggio contiene "Sign in".
  { category: C.PRIVATE, reason: 'private', test: /private video|this video is private/i,
    hint: 'Il video è stato reso privato dall\'autore.' },

  // --- Accesso limitato: il video esiste.
  { category: C.RESTRICTED, reason: 'age', test: /confirm your age|age[- ]restricted|inappropriate for some users/i,
    hint: 'Video con limite d\'età: servono i cookie di un account maggiorenne.' },
  { category: C.RESTRICTED, reason: 'members', test: /members[- ]only|join this channel/i,
    hint: 'Video riservato ai membri del canale.' },
  { category: C.RESTRICTED, reason: 'geo', test: /not made this video available in your country|not available in your country|geo[- ]?restrict/i,
    hint: 'Video non disponibile nel tuo paese.' },
  { category: C.RESTRICTED, reason: 'upcoming', test: /premieres? in|premiere will begin|live event will begin|this live event|is upcoming|will begin in/i,
    hint: 'Premiere o diretta non ancora iniziata.' },
  { category: C.RESTRICTED, reason: 'login', test: /sign in to view|login required|requires? (?:a )?login|use --cookies/i,
    hint: 'Il video richiede l\'accesso: carica i cookie.' },

  // --- Rimosso: solo frasi esplicite.
  { category: C.REMOVED, reason: 'removed', test: /removed by the uploader|account associated with this video has been terminated|has been terminated|violat\w* youtube(?:'|’)?s (?:terms|community guidelines|policy)|copyright (?:claim|removal|grounds)|removed (?:due to|following|for)|no longer available because|this video has been removed/i,
    hint: 'Il video è stato rimosso da YouTube.' },

  // --- Indisponibile senza spiegazione: ambiguo, si conferma con più controlli.
  { category: C.UNAVAILABLE, reason: 'unavailable', test: /video unavailable|this video is (?:no longer )?unavailable|this video is not available/i,
    hint: 'YouTube dice che il video non è disponibile: lo ricontrollo prima di segnarlo come sparito.' },

  // --- Download/formati: il video c'è.
  { category: C.FORMAT, reason: 'format', test: /requested format is not available|no video formats found|format(?:s)? (?:is |are )?not available/i,
    hint: 'La qualità scelta non è disponibile per questo video: prova una qualità diversa.' },
  { category: C.FORMAT, reason: 'http-403', test: /http error 403|403: forbidden/i,
    hint: 'YouTube ha rifiutato il download (403): spesso si risolve con cookie aggiornati o riprovando più tardi.' },
  { category: C.FORMAT, reason: 'postprocessing', test: /ffmpeg|ffprobe|postprocess|merger|conversion failed/i,
    hint: 'Errore nell\'unione o conversione del file scaricato.' },

  // --- Rete: transitoria.
  { category: C.NETWORK, reason: 'network', test: /unable to download (?:webpage|api page|json|video data)|timed? ?out|connection (?:reset|refused|aborted)|temporary failure in name resolution|name or service not known|network is unreachable|remote end closed|http error 5\d\d|\bssl\b|eof occurred|incomplete ?read/i,
    hint: 'YouTube non raggiungibile in questo momento: riprovo più tardi.' },

  // --- Interni: errori nostri dopo yt-dlp.
  { category: C.INTERNAL, reason: 'internal', test: /\benoent\b|unexpected token|is not valid json|unexpected end of json|metadati non trovati dopo l'estrazione/i,
    hint: 'Errore interno di Ondo nel leggere i file prodotti da yt-dlp: riprova.' }
];

// La riga più utile da mostrare: l'ultima "ERROR:" di yt-dlp, se c'è.
function mainLine(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l) || /\bERROR:/.test(l));
  const line = errorLine ?? lines[lines.length - 1] ?? '';
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

// Esiti che yt-dlp dichiara sul singolo video nella riga "ERROR:". Valgono più
// degli avvisi che la precedono: un "WARNING" su firme o runtime JS stampato
// prima di "ERROR: … Private video" non deve trasformare la risposta (il video è
// privato) in un problema della macchina che ferma tutta la verifica.
const VERDICT_CATEGORIES = new Set([C.BLOCKED, C.PRIVATE, C.RESTRICTED, C.REMOVED, C.UNAVAILABLE]);

function errorLines(text) {
  return text.split('\n').filter((l) => /\bERROR:/.test(l)).join('\n');
}

/**
 * Classifica un errore (Error, stringa o qualunque cosa abbia `message`).
 * @returns {{ category: string, reason: string, hint: string, message: string }}
 */
export function classifyYtdlpError(input) {
  const text = typeof input === 'string' ? input : String(input?.message ?? input ?? '');
  const errors = errorLines(text);
  if (errors) {
    const rule = RULES.find((r) => VERDICT_CATEGORIES.has(r.category) && r.test.test(errors));
    if (rule) return { category: rule.category, reason: rule.reason, hint: rule.hint, message: mainLine(text) };
  }
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { category: rule.category, reason: rule.reason, hint: rule.hint, message: mainLine(text) };
    }
  }
  return {
    category: C.UNKNOWN,
    reason: 'unknown',
    hint: 'Errore non riconosciuto: nessuno stato del video è stato cambiato.',
    message: mainLine(text)
  };
}

// Il video non esiste più su YouTube, con certezza.
export function isDefinitivelyGone(classification) {
  return classification.category === C.REMOVED || classification.category === C.PRIVATE;
}

// Errori che non riguardano il singolo video ma tutte le richieste a seguire:
// continuare servirebbe solo a riempire la libreria di errori uguali.
export function shouldStopRun(classification) {
  return classification.category === C.BLOCKED || classification.category === C.ENVIRONMENT;
}

// Forma salvata sul video/job: abbastanza per mostrare il motivo senza log.
export function errorRecord(classification, { attempts } = {}) {
  return {
    category: classification.category,
    reason: classification.reason,
    hint: classification.hint,
    message: classification.message,
    occurredAt: new Date().toISOString(),
    ...(attempts != null ? { attempts } : {})
  };
}
