import { useEffect } from 'react';
import { useDiscreet } from '../lib/discreetStore.js';

// Titolo della scheda del browser (M33): "<contesto> · Ondo", o solo "Ondo" se
// non c'è un contesto (es. dati non ancora caricati). Ripristina "Ondo" quando
// la pagina viene lasciata. In modalità discreta completa resta sempre "Ondo":
// il titolo della scheda si legge anche con la finestra in secondo piano.
export function useTitle(text) {
  const { mode } = useDiscreet();
  const shown = mode === 'all' ? null : text;
  useEffect(() => {
    document.title = shown ? `${shown} · Ondo` : 'Ondo';
    return () => { document.title = 'Ondo'; };
  }, [shown]);
}
