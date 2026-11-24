import { Pool } from 'pg';
import type { ContentBlock, Choice, VariableDeclaration } from '../types.js';
import type { SimpleCondition } from '@wanderline/shared';
import { isChoiceAudioType, choiceIdFromAudioType } from './choice-audio.js';

/**
 * Pick the title the player renders. Prefer the story-graph
 * title (set by the author via `StoryTitle` in Twee or `//title:`
 * in Ink) when it looks author-set; fall back to the project's
 * Wanderline-facing name when the graph title matches a known
 * parser default (`Untitled` / `Untitled Story`). This means an
 * uploaded source that forgot to set a title still renders the
 * project name in the `<h1>` instead of the literal word
 * "Untitled".
 *
 * Exported so the fallback logic is unit-testable in isolation
 * from the full DB-backed `buildStoryData` flow.
 */
export function resolveStoryTitle(rawTitle: unknown, projectName: unknown): string {
  const graphTitle = typeof rawTitle === 'string' ? rawTitle : '';
  const looksLikeParserDefault =
    !graphTitle || graphTitle === 'Untitled' || graphTitle === 'Untitled Story';
  if (!looksLikeParserDefault) return graphTitle;
  const fallback = typeof projectName === 'string' ? projectName.trim() : '';
  return fallback || graphTitle;
}

export class StoryDataError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'StoryDataError';
  }
}

/** One candidate audio file for a slot. `condition` absent means this
 * is the slot's default/fallback candidate. */
export interface AudioVariant {
  file: string;
  condition?: SimpleCondition;
}

/** One sound effect on a node. `offsetMs` absent means "as the passage
 * starts"; present, it's a point on the narration's timeline (or time
 * since arriving, on a passage with no narration). */
export interface StoryDataSfx extends AudioVariant {
  offsetMs?: number;
}

/**
 * Each single-value slot (voiceover/ambience/choice1/choice2) is a
 * list of candidates, not a single filename — a node can have
 * several, each gated by an optional variable condition. The player
 * (shared/src/audio-condition.ts's evaluateSimpleCondition) checks
 * conditioned candidates in order and falls back to the one
 * unconditioned candidate, if any; collectNodeAudio below always
 * orders the unconditioned candidate last so that fallback semantics
 * fall out of simple linear iteration. `sfx` entries don't follow
 * this "exactly one wins" model — each plays independently, gated by
 * its own condition (or unconditionally) — so they keep their
 * existing offset-based ordering instead.
 */
export interface StoryDataNodeAudio {
  voiceover?: AudioVariant[];
  ambience?: AudioVariant[];
  choice1?: AudioVariant[];
  choice2?: AudioVariant[];
  /** A choice's own cue, keyed by the choice's stable id — addresses
   * correctly under reordering, unlike choice1/choice2's ordinal
   * slots, which this coexists with rather than replaces (a choice
   * with no id yet still only ever uses those). */
  choices?: Record<string, AudioVariant[]>;
  sfx?: StoryDataSfx[];
}

export interface AssignmentRow {
  node_id: string;
  audio_type: string;
  audio_file_id: string;
  offset_ms?: number | null;
  condition?: SimpleCondition | null;
  /** Used only to order same-slot candidates deterministically
   * (conditioned-first, insertion order, then by file as a final
   * tiebreak) — real DB rows always have one; test fixtures may omit
   * it and just rely on the filename tiebreak. */
  created_at?: string;
}

/** A candidate still carrying its `created_at`, used only internally
 * while folding rows — stripped before the final result is returned
 * (the player has no use for it; it only exists to make ordering
 * deterministic across builds). */
// `string | Date`, not just `string` — node-pg's default column
// parsing hands back a `Date` object for a `timestamptz` column, not
// the string this field's old type claimed (found in review).
interface PendingVariant extends AudioVariant {
  created_at: string | Date;
}
interface PendingSfx extends StoryDataSfx {
  created_at: string | Date;
}

/** Conditioned candidates first (in created_at order), then the one
 * unconditioned/default candidate last, so a linear scan at playback
 * naturally implements "first matching condition wins, else
 * default." Only meaningful for the single-value slots — sfx entries
 * are each independently gated by their own condition (or play
 * unconditionally), not mutually exclusive alternatives, so sfx keeps
 * its existing offset-based ordering untouched by this. */
function compareSingleSlotVariants(a: PendingVariant, b: PendingVariant): number {
  const rankA = a.condition ? 0 : 1;
  const rankB = b.condition ? 0 : 1;
  if (rankA !== rankB) return rankA - rankB;
  // `created_at` is typed as `string` above, but the query actually
  // supplies a `Date` object (node-pg's default column parsing) —
  // found in review: comparing two DISTINCT Date instances for the
  // SAME timestamp with `!==` is always true (reference inequality,
  // not value), so equal-time rows never reached the filename
  // tiebreak below at all; worse, `<` on them then returned 1 in
  // BOTH directions for a genuine tie, making sort order depend on
  // whatever order Postgres happened to return the rows in. Compare
  // the actual timestamp VALUE — `new Date(...).getTime()` works
  // whether the value is already a Date or (for a row from a path
  // that parses it as a string) still a string.
  const timeA = new Date(a.created_at).getTime();
  const timeB = new Date(b.created_at).getTime();
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

function stripCreatedAt<T extends { created_at?: string | Date }>(
  variant: T,
): Omit<T, 'created_at'> {
  const { created_at: _createdAt, ...rest } = variant;
  return rest;
}

/**
 * Turn node_audio_assignments rows into the per-node audio block the
 * player reads, resolving file ids to filenames.
 *
 * SFX used to be dropped here outright: the editor could assign them and
 * the node panel could audition them, but they never reached a preview
 * or a build. They're emitted in a stable order (by offset, unset
 * first, then filename) so two builds of the same project produce the
 * same payload. An assignment whose file no longer resolves is left out
 * rather than emitted as undefined.
 */
export function collectNodeAudio(
  rows: AssignmentRow[],
  fileMap: Record<string, string>,
): Record<string, StoryDataNodeAudio> {
  // Null-prototype at both levels: `row.node_id` is an Ink/Twee knot
  // or stitch identifier, and `choiceId` (below) comes straight out
  // of `audio_type`'s `choice:<id>` encoding — both are author-
  // controlled text that can legally be `__proto__`. On an ordinary
  // `{}`, `byNode['__proto__']` (or `node.choices['__proto__']`)
  // reads the INHERITED Object.prototype object (truthy, so `??=`
  // skips assigning a fresh one) and the next `.push(...)` throws
  // trying to call a method Object.prototype doesn't have — a single
  // crafted row crashes every build/preview/export for the whole
  // project until it's manually deleted from the DB.
  const byNode: Record<
    string,
    {
      voiceover: PendingVariant[];
      ambience: PendingVariant[];
      choice1: PendingVariant[];
      choice2: PendingVariant[];
      choices: Record<string, PendingVariant[]>;
      sfx: PendingSfx[];
    }
  > = Object.create(null);
  for (const row of rows) {
    const file = fileMap[row.audio_file_id];
    if (!file) continue;
    const node = (byNode[row.node_id] ??= {
      voiceover: [],
      ambience: [],
      choice1: [],
      choice2: [],
      choices: Object.create(null) as Record<string, PendingVariant[]>,
      sfx: [],
    });
    const condition = row.condition ?? undefined;
    const created_at = row.created_at ?? '';
    if (isChoiceAudioType(row.audio_type)) {
      const choiceId = choiceIdFromAudioType(row.audio_type);
      (node.choices[choiceId] ??= []).push({
        file,
        ...(condition ? { condition } : {}),
        created_at,
      });
      continue;
    }
    switch (row.audio_type) {
      case 'voiceover':
      case 'ambience':
      case 'choice1':
      case 'choice2':
        node[row.audio_type].push({ file, ...(condition ? { condition } : {}), created_at });
        break;
      case 'sfx': {
        const offset = row.offset_ms;
        node.sfx.push({
          file,
          ...(typeof offset === 'number' && Number.isFinite(offset) && offset >= 0
            ? { offsetMs: offset }
            : {}),
          ...(condition ? { condition } : {}),
          created_at,
        });
        break;
      }
    }
  }
  // Same null-prototype reasoning as `byNode`/`node.choices` above —
  // `nodeId` and `choiceId` are both still author-controlled text at
  // this point.
  const result: Record<string, StoryDataNodeAudio> = Object.create(null);
  for (const [nodeId, node] of Object.entries(byNode)) {
    const audio: StoryDataNodeAudio = {};
    for (const slot of ['voiceover', 'ambience', 'choice1', 'choice2'] as const) {
      if (node[slot].length > 0) {
        audio[slot] = node[slot].sort(compareSingleSlotVariants).map(stripCreatedAt);
      }
    }
    const choiceIds = Object.keys(node.choices);
    if (choiceIds.length > 0) {
      audio.choices = Object.create(null) as Record<string, AudioVariant[]>;
      for (const choiceId of choiceIds) {
        audio.choices[choiceId] = node.choices[choiceId]
          .sort(compareSingleSlotVariants)
          .map(stripCreatedAt);
      }
    }
    if (node.sfx.length > 0) {
      audio.sfx = node.sfx
        .sort(
          (a, b) =>
            (a.offsetMs ?? -1) - (b.offsetMs ?? -1) ||
            (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
        )
        .map(stripCreatedAt);
    }
    result[nodeId] = audio;
  }
  return result;
}

export interface StoryDataNode {
  id: string;
  type: string;
  // ContentBlock (DEV-199 Phase 2): a `~`-assignment block carries no
  // `.text` — the player walks this array to mutate its variable
  // store (App.tsx's applyNodeAssignments) and filters to text blocks
  // (isTextBlock) before deriving anything display-facing.
  content: ContentBlock[];
  choices: Choice[];
  divert: string | null;
  tags: string[];
  audio?: StoryDataNodeAudio;
  metadata?: {
    // Nullable in Postgres — story-data-builder forwards row.transcript
    // directly so this can be null when no override is stored.
    transcript?: string | null;
    delayBeforeMs?: number;
    delayAfterMs?: number;
    autoAdvance?: boolean;
    autoAdvanceDelayMs?: number;
    choice1TimestampMs?: number;
    choice2TimestampMs?: number;
    theme?: string;
  };
}

export interface StoryData {
  id: string;
  title: string;
  audioBaseUrl: string;
  startNode: string;
  nodes: Record<string, StoryDataNode>;
  indicatorAudio: { choice1?: string; choice2?: string };
  /** Project-level variable declarations (DEV-199). Not per-node, so
   * it's wired in separately from the nodes loop in buildStoryData. */
  variables?: VariableDeclaration[];
  settings?: {
    password?: string;
    voiceoverVolume?: number;
    backgroundMusicVolume?: number;
    /** Per-node ambience loops and sound effects. */
    ambienceVolume?: number;
    indicatorVolume?: number;
    /**
     * URL of the default indicator sound. Resolved server-side from
     * settings.defaultIndicatorAudioId so the player can load it
     * directly without a second round-trip to look up the filename.
     */
    defaultIndicatorAudioUrl?: string | null;
    choiceAudioDelayMs?: number;
    // UI options — see frontend SettingsTab "Player display".
    captionsDefault?: boolean;
    /** Project-wide default for auto-advancing between passages.
     * Undefined means off; a node's own metadata still overrides. */
    autoAdvance?: boolean;
    showProgressBar?: boolean;
    showChoiceList?: boolean;
    // Bluetooth / headphone button mapping. See frontend
    // BluetoothControls type for the action enum.
    bluetoothControls?: {
      nextTrack?: 'choice1' | 'cycle_choices' | 'confirm' | 'divert';
      previousTrack?: 'choice2' | 'cycle_choices' | 'go_back';
    };
    // +: per-project theme. Shape mirrors ProjectTheme
    // in frontend/src/api/client.ts; kept loose here so the player
    // payload doesn't need to import the full type tree. `components`
    // is the per-component override map keyed by ComponentId.
    theme?: {
      variables?: Record<string, string | undefined>;
      bodyFont?: string;
      bodyFontWeights?: string[];
      headingFont?: string;
      headingFontWeights?: string[];
      customCss?: string;
      components?: Record<string, Record<string, string | undefined>>;
    };
  };
  backgroundMusic?: string[];
}

export interface AudioFileRow {
  id: string;
  project_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  category: string;
}

export interface BuildStoryDataResult {
  storyData: StoryData;
  audioFiles: AudioFileRow[];
  fileMap: Record<string, string>;
  project: Record<string, unknown>;
}

/**
 * How the project's story password should be represented in the
 * payload we hand the client.
 *
 * - `embed` puts the plaintext password in `settings.password` and
 *   relies on the player comparing it in the browser. This is only
 *   sound for the static export path, where there is no server at
 *   request time to compare against; the exported bundle is a pile of
 *   files and anyone holding it can read story.json regardless. Do not
 *   use it for anything served over HTTP.
 * - `omit` strips the password entirely. Every server-served route uses
 *   this: the authed editor preview has already passed requireAuth, and
 *   the public preview is gated server-side before the story data is
 *   ever rendered (see mountPublicPreviewRoutes). Shipping the password
 *   to those clients made the gate decorative, because the value sat in
 *   view-source next to the story it was protecting.
 */
export type PasswordExposure = 'embed' | 'omit';

export interface BuildStoryDataOptions {
  audioBaseUrl: string;
  passwordExposure?: PasswordExposure;
}

/**
 * Loads all project data from the database and assembles a StoryData object.
 * This was previously duplicated in 3 places (sync generate, async generate, preview).
 */
export async function buildStoryData(
  pool: Pool,
  projectId: string,
  options: BuildStoryDataOptions,
): Promise<BuildStoryDataResult> {
  // Get all project data
  const projectResult = await pool.query(
    `
    SELECT p.*,
           ps.story_graph,
           pset.settings
    FROM projects p
    LEFT JOIN project_stories ps ON p.id = ps.project_id
    LEFT JOIN project_settings pset ON p.id = pset.project_id
    WHERE p.id = $1
  `,
    [projectId],
  );

  if (projectResult.rows.length === 0) {
    throw new StoryDataError('Project not found', 404);
  }

  const project = projectResult.rows[0];

  if (!project.story_graph) {
    throw new StoryDataError('Project has no story. Upload an Ink file first.', 400);
  }

  // Get audio files and assignments
  const audioResult = await pool.query('SELECT * FROM audio_files WHERE project_id = $1', [
    projectId,
  ]);

  const assignmentsResult = await pool.query(
    'SELECT * FROM node_audio_assignments WHERE project_id = $1',
    [projectId],
  );

  const metadataResult = await pool.query('SELECT * FROM node_metadata WHERE project_id = $1', [
    projectId,
  ]);

  // Get characters for theme mapping
  const charactersResult = await pool.query(
    'SELECT id, theme FROM characters WHERE project_id = $1',
    [projectId],
  );
  const characterThemes: Record<string, string> = {};
  for (const char of charactersResult.rows) {
    characterThemes[char.id] = char.theme || 'purple';
  }

  // Build metadata map
  const nodeMetadata: Record<string, StoryDataNode['metadata']> = {};
  for (const row of metadataResult.rows) {
    nodeMetadata[row.node_id] = {
      transcript: row.transcript,
      delayBeforeMs: row.delay_before_ms,
      delayAfterMs: row.delay_after_ms,
      autoAdvance: row.auto_advance,
      autoAdvanceDelayMs: row.auto_advance_delay_ms,
      choice1TimestampMs: row.choice_1_timestamp_ms,
      choice2TimestampMs: row.choice_2_timestamp_ms,
      theme: row.character_id ? characterThemes[row.character_id] : undefined,
    };
  }

  // Build file ID to filename map
  const fileMap: Record<string, string> = {};
  for (const file of audioResult.rows) {
    fileMap[file.id] = file.filename;
  }

  // Get indicator audio filenames from settings
  const settings = project.settings || {};
  const indicatorAudioSettings = settings.choiceIndicatorAudio || {};
  const choice1IndicatorFile = indicatorAudioSettings.choice1FileId
    ? fileMap[indicatorAudioSettings.choice1FileId]
    : undefined;
  const choice2IndicatorFile = indicatorAudioSettings.choice2FileId
    ? fileMap[indicatorAudioSettings.choice2FileId]
    : undefined;
  // Default system-sound indicator (settings.defaultIndicatorAudioId).
  // Resolve to a URL the player can fetch directly so it doesn't have
  // to call back to /audio to look up the filename.
  const defaultIndicatorFile = settings.defaultIndicatorAudioId
    ? fileMap[settings.defaultIndicatorAudioId]
    : undefined;
  const defaultIndicatorAudioUrl = defaultIndicatorFile
    ? `${options.audioBaseUrl}${defaultIndicatorFile}`
    : null;

  // Get background music files (sorted alphabetically for consistent order)
  const backgroundMusicFiles = audioResult.rows
    .filter((f: { category: string }) => f.category === 'music')
    .sort((a: { original_name: string }, b: { original_name: string }) =>
      a.original_name.localeCompare(b.original_name),
    )
    .map((f: { filename: string }) => f.filename);

  // Prefer the story-graph title, fall back to the project name
  // when the graph title looks like a parser default. See
  // resolveStoryTitle for the reasoning + exact cases.
  const resolvedTitle = resolveStoryTitle(project.story_graph.title, project.name);

  // Create story data for the app
  const storyData: StoryData = {
    id: project.story_graph.id,
    title: resolvedTitle,
    audioBaseUrl: options.audioBaseUrl,
    startNode: project.story_graph.startNode,
    nodes: {},
    indicatorAudio: {
      choice1: choice1IndicatorFile,
      choice2: choice2IndicatorFile,
    },
    settings: {
      // Defaults to 'embed' so the build pipeline (the only caller that
      // legitimately needs the plaintext) keeps working untouched. Every
      // HTTP-served caller passes 'omit' explicitly.
      password: options.passwordExposure === 'omit' ? undefined : settings.password,
      voiceoverVolume: settings.voiceoverVolume,
      backgroundMusicVolume: settings.backgroundMusicVolume,
      ambienceVolume: settings.ambienceVolume,
      indicatorVolume: settings.indicatorVolume,
      defaultIndicatorAudioUrl,
      choiceAudioDelayMs: settings.choiceAudioDelayMs,
      captionsDefault: settings.captionsDefault,
      autoAdvance: settings.autoAdvance,
      showProgressBar: settings.showProgressBar,
      showChoiceList: settings.showChoiceList,
      bluetoothControls: settings.bluetoothControls,
      // theme flows through to the player payload so preview
      // + build can both read it. The build pipeline does the font
      // download + injection; the live preview path injects a Google
      // Fonts <link> instead.
      theme: settings.theme,
    },
    backgroundMusic: backgroundMusicFiles.length > 0 ? backgroundMusicFiles : undefined,
    // Project-level, not per-node (DEV-199 Phase 2) — the loop below
    // only ever touches storyData.nodes, so this needs its own line.
    variables: project.story_graph.variables,
  };

  const nodeAudio = collectNodeAudio(assignmentsResult.rows as AssignmentRow[], fileMap);

  // Process nodes, adding audio and metadata
  for (const [nodeId, node] of Object.entries(
    project.story_graph.nodes as Record<string, unknown>,
  )) {
    const nodeData = node as Record<string, unknown>;
    const metadata = nodeMetadata[nodeId];

    storyData.nodes[nodeId] = {
      ...nodeData,
      audio: nodeAudio[nodeId],
      metadata: metadata || undefined,
    } as StoryDataNode;
  }

  return { storyData, audioFiles: audioResult.rows, fileMap, project };
}
