// The stored parser report, read defensively.
//
// `StoryGraph.validation` is typed as required, but it is a JSONB
// column written by whatever parser version was current at upload, and
// normalizeStoryGraph deliberately passes it through untouched rather
// than backfilling ("`validation` is left exactly as stored").
//
// One accessor, because the two consumers have to agree: the Ship tab
// counts the errors and the Story tab renders them. Guarding only the
// count would leave a "couldn't check" row linking to a panel that
// throws on the graph the guard exists for.
//
// Per field, not all-or-nothing. A blob with a usable `errors` array
// and a broken `warnings` one still knows about real parser errors on
// a story someone is about to build; dropping both halves because one
// is malformed would make those errors silently invisible.

import type { StoryGraph, ValidationMessage } from '../api/client';

export interface StoredValidation {
  /** `null` when the blob carries no usable array — which means "we do
   * not know", not "there are none". */
  errors: ValidationMessage[] | null;
  warnings: ValidationMessage[] | null;
}

export function readValidation(graph: StoryGraph | null | undefined): StoredValidation {
  const validation = graph?.validation as Partial<StoryGraph['validation']> | undefined;
  return {
    errors: Array.isArray(validation?.errors) ? validation.errors : null,
    warnings: Array.isArray(validation?.warnings) ? validation.warnings : null,
  };
}
