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

import type { StoryGraph, ValidationMessage } from '../api/client';

export interface StoredValidation {
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
}

/** The blob, or null when the graph does not carry a usable one. */
export function readValidation(graph: StoryGraph | null | undefined): StoredValidation | null {
  const validation = graph?.validation;
  if (!validation || !Array.isArray(validation.errors) || !Array.isArray(validation.warnings)) {
    return null;
  }
  return { errors: validation.errors, warnings: validation.warnings };
}
