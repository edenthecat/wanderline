/**
 * `useVocab` — resolve the effective terminology skin for a
 * project. Reads the project's source_language + the user-configured
 * nomenclature preference from Settings; falls back to Ink when
 * either is missing.
 *
 * Not backed by a Context — v1 threads the source_language +
 * preference as props from ProjectDetailPage down to consumers.
 * When more surfaces need it, a NomenclatureProvider is the natural
 * next step; for now the direct prop path keeps the component tree
 * explicit and easy to grep.
 */

import { useMemo } from 'react';
import type { Nomenclature, NomenclaturePreference, Vocab } from '../lib/nomenclature';
import { resolveVocab } from '../lib/nomenclature';

export function useVocab(
  sourceLanguage: Nomenclature | null | undefined,
  preference: NomenclaturePreference | null | undefined = 'auto',
): Vocab {
  return useMemo(() => resolveVocab(sourceLanguage, preference), [sourceLanguage, preference]);
}
