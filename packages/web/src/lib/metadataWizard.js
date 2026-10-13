import { useEffect, useState } from 'react';

// Apertura del wizard "Aggiorna metadati" da qualunque punto dell'app (profilo,
// selezione, fonte, menu della card, dettaglio video, Attività): un solo host
// montato nel layout, come per i dialoghi.
//   openMetadataWizard({ label, videos })        → dal passo 1
//   openMetadataWizard({ label, step: 'review' }) → direttamente alla revisione
const STATE = (globalThis.__ondoMetaWizard ??= { current: null, listeners: new Set() });

export function openMetadataWizard(options) {
  STATE.current = { ...options, key: Date.now() };
  for (const l of STATE.listeners) l(STATE.current);
}

export function closeMetadataWizard() {
  STATE.current = null;
  for (const l of STATE.listeners) l(null);
}

export function useMetadataWizard() {
  const [cur, setCur] = useState(STATE.current);
  useEffect(() => {
    STATE.listeners.add(setCur);
    return () => STATE.listeners.delete(setCur);
  }, []);
  return cur;
}

export const FIELD_LABEL = {
  title: 'Titolo',
  description: 'Descrizione',
  tags: 'Tag',
  thumbnail: 'Copertina',
  chapters: 'Capitoli',
  uploadDate: 'Data di pubblicazione',
  durationSeconds: 'Durata',
  presence: 'Presenza su YouTube'
};
