export interface StoryData {
  id: string;
  title: string;
  nodes: Record<string, StoryNode>;
  startNode: string;
  audioBaseUrl: string;
}

export interface StoryNode {
  id: string;
  type: 'knot' | 'stitch' | 'gather';
  content: { text: string; tags: string[] }[];
  choices: Choice[];
  divert: string | null;
  tags: string[];
  audio?: AudioAssignment;
  metadata?: NodeMetadata;
}

export interface Choice {
  text: string;
  target: string;
}

export interface AudioAssignment {
  voiceover?: string;
  ambience?: string;
  /** `offsetMs` absent: as the passage starts. See passage-sfx.ts. */
  sfx?: Array<{ file: string; offsetMs?: number }>;
}

export interface NodeMetadata {
  transcript?: string;
  delayBeforeMs?: number;
  delayAfterMs?: number;
  autoAdvance?: boolean;
  autoAdvanceDelayMs?: number;
}

export type PlayerState = 'loading' | 'ready' | 'playing' | 'paused' | 'ended';
