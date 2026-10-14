import { useCallback, useEffect, useState } from 'react';

const STEP = 36;

// Elenchi lunghi che si allungano scorrendo, come YouTube: si disegnano le
// prime STEP card e altre STEP ogni volta che la fine dell'elenco arriva a
// meno di uno schermo e mezzo. Con centinaia di video la pagina non costruisce
// (né decodifica le copertine di) quello che nessuno sta guardando, ed è lì
// che lo scorrimento su telefono si impuntava.
//
// I dati restano tutti in memoria: filtri, conteggi e "Seleziona tutti"
// lavorano sull'elenco intero, qui si limita solo cosa va nel DOM.
// `resetKey`: quando cambia (filtro, ordine…) si riparte dalle prime STEP.
export function useIncremental(items, resetKey) {
  const [count, setCount] = useState(STEP);
  const [node, setNode] = useState(null);

  useEffect(() => { setCount(STEP); }, [resetKey]);

  const total = items?.length ?? 0;
  const hasMore = count < total;

  // Un osservatore nuovo a ogni allungamento: appena collegato riferisce se
  // il segnaposto è ancora vicino, e in quel caso si allunga ancora (schermi
  // alti, o un salto in fondo alla pagina).
  useEffect(() => {
    if (!node || !hasMore) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setCount((c) => c + STEP);
    }, { rootMargin: '0px 0px 150% 0px' });
    io.observe(node);
    return () => io.disconnect();
  }, [node, hasMore, count]);

  const sentinelRef = useCallback((el) => setNode(el), []);
  return { visible: hasMore ? items.slice(0, count) : (items ?? []), hasMore, sentinelRef };
}
