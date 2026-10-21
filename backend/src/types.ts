/**
 * Re-export shared types for the backend
 * This allows us to use the types without building the shared package first
 */

import {
  isTextBlock,
  type Expression,
  type VariableDeclaration,
  type Statement,
  type ContentBlock,
  type TextBlock,
  type AssignmentBlock,
  type TextContent,
} from '@wanderline/shared';

export {
  isTextBlock,
  type Expression,
  type VariableDeclaration,
  type Statement,
  type ContentBlock,
  type TextBlock,
  type AssignmentBlock,
  type TextContent,
};

// === Story Graph Types ===

export interface StoryGraph {
  id: string;
  title: string;
  nodes: Record<string, StoryNode>;
  startNode: string;
  validation: ValidationResult;
  source?: string;
  /**
   * Project-level variable declarations (DEV-199 Phase 0). Parsed
   * from Ink's VAR/CONST preamble (Phase 1) or a Twine dialect's own
   * declaration syntax (Phases 6-9) — never partially populated by
   * either parser yet; this field exists now so the schema, the Yjs
   * collab codec, and the manifest pipeline don't need another
   * breaking shape change once parsing lands.
   */
  variables?: VariableDeclaration[];
  /**
   * Twee-side round-trip preservation. Neither field is used
   * by the Ink pipeline; both are populated by parseTwee and
   * consumed by emitTwee, so a Twee upload → graph edit → Twee export
   * cycle preserves fields the story_graph shape can't otherwise
   * represent.
   *
   * `twee.storyData` retains every field of the original `:: StoryData`
   * JSON (ifid, format, format-version, tag-colors, zoom, ...). The
   * `start` key is re-emitted from `startNode` so a graph edit that
   * changes the start passage still round-trips.
   *
   * `twee.specials` retains the raw body text of Twee's "special"
   * passages (StoryInit, PassageHeader, PassageFooter, StoryCaption,
   * StoryMenu, StoryAuthor, StorySubtitle). Their bodies aren't
   * story-graph nodes — they're global wrappers — so we can't
   * store them under `nodes`. Keyed by passage name.
   */
  twee?: {
    storyData?: Record<string, unknown>;
    specials?: Record<string, string>;
  };
}

export interface StoryNode {
  id: string;
  type: NodeType;
  parent: string | null;
  content: ContentBlock[];
  choices: Choice[];
  divert: string | null;
  tags: string[];
  lineNumber: number;
  audio?: AudioAssignment;
  /**
   * Twee 3 passage header metadata (`{"position":"120,240",
   * "size":"200,100"}` etc.). Populated by parseTwee and re-emitted
   * by emitTwee so Twine's grid layout survives a round-trip. Not
   * used by Ink or the runtime — pure round-trip preservation.
   */
  metadata?: Record<string, unknown>;
}

export type NodeType = 'knot' | 'stitch' | 'gather';

// ContentBlock/TextBlock/AssignmentBlock/TextContent/isTextBlock are
// re-exported from @wanderline/shared above — see expression-types.ts
// for the doc comments. Shared (not duplicated per the rest of
// StoryGraph) because backend validation, player-app playback, and
// the editor UI must all agree on what counts as a text vs assignment
// block.

export interface Choice {
  text: string;
  target: string;
  sticky: boolean;
  fallback: boolean;
  /**
   * A single boolean expression gating this choice's visibility
   * (DEV-199 Phase 4/7-9). Ink's `{c1}{c2}` multi-condition prefixes
   * AND together into one expression at parse time, so this is never
   * a list — see the plan doc's Q4.
   */
  condition?: Expression | null;
  tags: string[];
}

export interface AudioAssignment {
  voiceover?: string;
  ambience?: string;
  sfx?: string[];
}

// === Validation Types ===

export interface ValidationResult {
  valid: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
}

export interface ValidationMessage {
  type: ValidationType;
  message: string;
  nodeId?: string;
  lineNumber?: number;
  /**
   * structured arguments that pair with `type` so the
   * frontend can re-render the message under the active nomenclature
   * (Phase 4 vocab). Optional — existing consumers still render
   * `message` verbatim. When set, args carry the interpolation
   * variables the frontend template needs (`{targetName}`,
   * `{sourceNode}`, etc.). Values may be strings or numbers; the
   * frontend template layer coerces to string at render time.
   */
  args?: Record<string, string | number>;
}

export type ValidationType =
  | 'missing_target'
  | 'unreachable_node'
  | 'empty_node'
  | 'circular_reference'
  | 'missing_start'
  | 'duplicate_node'
  | 'syntax_error'
  | 'orphaned_stitch';

// === Project Types ===

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  story?: StoryGraph;
  settings: ProjectSettings;
}

export interface ProjectSettings {
  controls: ControlMapping;
  audioDefaults: AudioDefaults;
}

export interface ControlMapping {
  playPause: ControlAction;
  nextTrack: ControlAction;
  previousTrack: ControlAction;
  doubleTap?: ControlAction;
  longPress?: ControlAction;
}

export type ControlAction =
  | 'play_pause'
  | 'next_choice'
  | 'previous_choice'
  | 'confirm_choice'
  | 'repeat'
  | 'menu'
  | 'restart_section';

export interface AudioDefaults {
  autoPlay: boolean;
  crossfadeDuration: number;
  volume: number;
}
