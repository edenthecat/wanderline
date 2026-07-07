import { Pool } from 'pg';

export class StoryDataError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'StoryDataError';
  }
}

export interface StoryDataNode {
  id: string;
  type: string;
  content: { text: string }[];
  choices: { text: string; target: string }[];
  divert: string | null;
  tags: string[];
  audio?: { voiceover?: string; ambience?: string; choice1?: string; choice2?: string };
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
  settings?: {
    password?: string;
    voiceoverVolume?: number;
    backgroundMusicVolume?: number;
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

export interface BuildStoryDataOptions {
  audioBaseUrl: string;
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

  // Build audio assignments map
  const audioAssignments: Record<
    string,
    { voiceover?: string; ambience?: string; choice1?: string; choice2?: string }
  > = {};
  for (const row of assignmentsResult.rows) {
    if (!audioAssignments[row.node_id]) {
      audioAssignments[row.node_id] = {};
    }
    const audioType = row.audio_type as string;
    if (
      audioType === 'voiceover' ||
      audioType === 'ambience' ||
      audioType === 'choice1' ||
      audioType === 'choice2'
    ) {
      audioAssignments[row.node_id][audioType] = row.audio_file_id;
    }
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

  // Create story data for the app
  const storyData: StoryData = {
    id: project.story_graph.id,
    title: project.story_graph.title,
    audioBaseUrl: options.audioBaseUrl,
    startNode: project.story_graph.startNode,
    nodes: {},
    indicatorAudio: {
      choice1: choice1IndicatorFile,
      choice2: choice2IndicatorFile,
    },
    settings: {
      password: settings.password,
      voiceoverVolume: settings.voiceoverVolume,
      backgroundMusicVolume: settings.backgroundMusicVolume,
      indicatorVolume: settings.indicatorVolume,
      defaultIndicatorAudioUrl,
      choiceAudioDelayMs: settings.choiceAudioDelayMs,
      captionsDefault: settings.captionsDefault,
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
  };

  // Process nodes, adding audio and metadata
  for (const [nodeId, node] of Object.entries(
    project.story_graph.nodes as Record<string, unknown>,
  )) {
    const nodeData = node as Record<string, unknown>;
    const assignment = audioAssignments[nodeId];
    const metadata = nodeMetadata[nodeId];

    storyData.nodes[nodeId] = {
      ...nodeData,
      audio: assignment
        ? {
            voiceover: assignment.voiceover ? fileMap[assignment.voiceover] : undefined,
            ambience: assignment.ambience ? fileMap[assignment.ambience] : undefined,
            choice1: assignment.choice1 ? fileMap[assignment.choice1] : undefined,
            choice2: assignment.choice2 ? fileMap[assignment.choice2] : undefined,
          }
        : undefined,
      metadata: metadata || undefined,
    } as StoryDataNode;
  }

  return { storyData, audioFiles: audioResult.rows, fileMap, project };
}
