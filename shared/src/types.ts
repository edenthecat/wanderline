/**
 * Wanderline Shared Types
 * Types for the story graph format and related structures
 */

// === Story Graph Types ===

export interface StoryGraph {
  /** Unique identifier for the story */
  id: string;
  /** Title of the story (from INK metadata or filename) */
  title: string;
  /** All nodes in the story indexed by their full path */
  nodes: Record<string, StoryNode>;
  /** The starting node path */
  startNode: string;
  /** Validation warnings and errors */
  validation: ValidationResult;
  /** Original INK source (optional, for reference) */
  source?: string;
}

export interface StoryNode {
  /** Full path identifier (e.g., "knot_name" or "knot_name.stitch_name") */
  id: string;
  /** Type of node */
  type: NodeType;
  /** Parent knot path (null for root-level knots) */
  parent: string | null;
  /** Text content of the node */
  content: TextContent[];
  /** Choices available at this node */
  choices: Choice[];
  /** Direct divert target (if any) */
  divert: string | null;
  /** Tags associated with this node */
  tags: string[];
  /** Line number in source file (for debugging) */
  lineNumber: number;
  /** Audio assignments (populated by editor) */
  audio?: AudioAssignment;
}

export type NodeType = 'knot' | 'stitch' | 'gather';

export interface TextContent {
  /** The text to display */
  text: string;
  /** Tags on this specific line */
  tags: string[];
  /** Inline logic/conditionals (simplified) */
  conditions?: string[];
}

export interface Choice {
  /** The choice text displayed to the user */
  text: string;
  /** Target node path when this choice is selected */
  target: string;
  /** Whether this choice is sticky (can be selected multiple times) */
  sticky: boolean;
  /** Whether this choice is a fallback (shown when others are exhausted) */
  fallback: boolean;
  /** Conditions required to show this choice */
  conditions?: string[];
  /** Tags on this choice */
  tags: string[];
}

export interface AudioAssignment {
  /** Primary voiceover audio file */
  voiceover?: string;
  /** Ambient/background audio */
  ambience?: string;
  /** Sound effects */
  sfx?: string[];
}

// === Validation Types ===

export interface ValidationResult {
  /** Whether the story is valid (no errors) */
  valid: boolean;
  /** Error messages that prevent the story from working */
  errors: ValidationMessage[];
  /** Warning messages that might indicate issues */
  warnings: ValidationMessage[];
}

export interface ValidationMessage {
  /** Type of validation issue */
  type: ValidationType;
  /** Human-readable message */
  message: string;
  /** Node ID where the issue was found (if applicable) */
  nodeId?: string;
  /** Line number in source (if applicable) */
  lineNumber?: number;
}

export type ValidationType =
  | 'missing_target' // Divert/choice points to non-existent node
  | 'unreachable_node' // Node cannot be reached from start
  | 'empty_node' // Node has no content
  | 'circular_reference' // Potential infinite loop
  | 'missing_start' // No start node found
  | 'duplicate_node' // Multiple nodes with same ID
  | 'syntax_error' // INK syntax error
  | 'orphaned_stitch'; // Stitch outside of any knot

// === Project Types ===

export interface Project {
  /** Unique project identifier */
  id: string;
  /** Project name */
  name: string;
  /** Project description */
  description?: string;
  /** Created timestamp */
  createdAt: Date;
  /** Last modified timestamp */
  updatedAt: Date;
  /** The parsed story graph */
  story?: StoryGraph;
  /** Project settings */
  settings: ProjectSettings;
}

export interface ProjectSettings {
  /** Bluetooth control mappings */
  controls: ControlMapping;
  /** Default audio settings */
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
  /** Auto-play audio when node is reached */
  autoPlay: boolean;
  /** Fade duration between nodes (ms) */
  crossfadeDuration: number;
  /** Default volume (0-1) */
  volume: number;
}
