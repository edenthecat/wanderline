/**
 * nomenclature skin. Terminology follows the import format —
 * knot/stitch/choice/divert for Ink, passage/link for Twee — and can
 * be overridden by the user in Settings.
 *
 * Consume via useVocab() (see ../hooks/useVocab.tsx). Components should
 * NEVER hard-code "Knots" / "Passages" / "Choices" / "Links" — instead
 * they read from the returned Vocab. That makes the skin a one-liner
 * change per surface and keeps the source-language toggle honest.
 */

export type Nomenclature = 'ink' | 'twee';

export interface Vocab {
  /** e.g. "knot" / "passage" — story node singular. */
  node: { singular: string; plural: string };
  /** e.g. "stitch" (Ink) / "" (Twee has no sub-node concept). */
  subNode: { singular: string; plural: string };
  /** e.g. "choice" / "link" — outgoing branches from a node. */
  choice: { singular: string; plural: string };
  /** e.g. "divert" (Ink) / "continue" (Twee) — implicit next-node arrow. */
  divert: string;
  /** e.g. "content" / "prose" — the body text of a node. */
  content: string;
  /** e.g. "tag" — both formats share the concept but the copy differs. */
  tag: { singular: string; plural: string };
  /** e.g. "ending" / "end" — terminal-node label. */
  ending: string;
  /** Editor toolbar label. */
  sourceLabel: string;
  /** File extension hint the upload picker + editor tab surface. */
  fileExtHint: string;
  /** Copy for a fresh-file upload CTA. */
  uploadStoryFile: string;
  /** Copy for replacing the persisted source. */
  replaceStoryFile: string;
  /** Error-message header for a missing target. */
  missingNode: string;
  /** Error-message header for an unreachable node. */
  orphanedNode: string;
}

export const INK_VOCAB: Vocab = {
  node: { singular: 'knot', plural: 'knots' },
  subNode: { singular: 'stitch', plural: 'stitches' },
  choice: { singular: 'choice', plural: 'choices' },
  divert: 'divert',
  content: 'content',
  tag: { singular: 'tag', plural: 'tags' },
  ending: 'ending',
  sourceLabel: 'Ink source',
  fileExtHint: '.ink',
  uploadStoryFile: 'Upload .ink file',
  replaceStoryFile: 'Replace story file',
  missingNode: 'Missing knot',
  orphanedNode: 'Unreachable knot',
};

export const TWEE_VOCAB: Vocab = {
  node: { singular: 'passage', plural: 'passages' },
  // Twee has no sub-node hierarchy — set empty so Story stats can
  // omit the "N sub-nodes" line entirely instead of showing "0 stitches".
  subNode: { singular: '', plural: '' },
  choice: { singular: 'link', plural: 'links' },
  divert: 'continue',
  content: 'prose',
  tag: { singular: 'tag', plural: 'tags' },
  ending: 'end',
  sourceLabel: 'Twee 3 source',
  fileExtHint: '.tw3',
  uploadStoryFile: 'Upload .tw3 file',
  replaceStoryFile: 'Replace story file',
  missingNode: 'Missing passage',
  orphanedNode: 'Unreachable passage',
};

/**
 * nomenclature preference — either follow the source
 * language automatically or lock to one vocab regardless of source.
 * Stored under `project_settings.settings.nomenclature`; default
 * 'auto'.
 */
export type NomenclaturePreference = 'auto' | 'ink' | 'twee';

/**
 * Resolve the effective vocab for a project. `preference` overrides
 * `sourceLanguage` when it's not 'auto'. Returns INK_VOCAB as the
 * safe fallback when either is missing.
 */
export function resolveVocab(
  sourceLanguage: Nomenclature | null | undefined,
  preference: NomenclaturePreference | null | undefined = 'auto',
): Vocab {
  const effective =
    preference === 'ink' || preference === 'twee' ? preference : (sourceLanguage ?? 'ink');
  return effective === 'twee' ? TWEE_VOCAB : INK_VOCAB;
}
