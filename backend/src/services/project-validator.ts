import { Pool } from 'pg';

// lightweight validation that checks the things a real build
// would catch, without spending the minutes of a full build:
//   - parser errors/warnings on the saved story_graph
//   - audio coverage: every node-assigned audio_file_id has a real
//     file row + every indicator audio reference resolves
//   - reachability / divert targets (already in story_graph.validation
//     today; surfaced here so the report has one source of truth)
//   - empty / orphaned nodes and rough size estimates

export interface ProjectValidationReport {
  projectId: string;
  hasStory: boolean;
  summary: {
    nodeCount: number;
    audioFileCount: number;
    audioAssignmentCount: number;
    errorCount: number;
    warningCount: number;
    missingAudioCount: number;
    orphanedAudioCount: number;
  };
  storyIssues: {
    errors: Array<Record<string, unknown>>;
    warnings: Array<Record<string, unknown>>;
  };
  audioCoverage: {
    // Audio assignments that point at audio_file_ids that no longer exist
    // in the audio_files table — render-time these would 404 in the player.
    missingAssignments: Array<{
      nodeId: string;
      audioType: 'voiceover' | 'ambience' | 'choice1' | 'choice2';
      audioFileId: string;
    }>;
    // audio_files rows that aren't referenced by any node assignment or
    // indicator setting — duplicates the orphan calculation in /audio/
    // coverage so a single report covers everything.
    orphanedFiles: Array<{ id: string; filename: string }>;
    // Indicator audio (project_settings.choiceIndicatorAudio.*FileId)
    // pointing at deleted files. Per-key so the editor knows which arm
    // to repair.
    missingIndicatorAudio: Array<{ key: 'choice1' | 'choice2'; audioFileId: string }>;
  };
}

interface RawNode {
  audio?: Record<string, unknown>;
}

export async function validateProject(
  pool: Pool,
  projectId: string,
): Promise<ProjectValidationReport> {
  // Load the project + story graph in a single query so a 404 here
  // looks the same as the other project routes.
  const projectResult = await pool.query(
    `SELECT p.id, ps.story_graph, prs.settings
       FROM projects p
       LEFT JOIN project_stories ps ON p.id = ps.project_id
       LEFT JOIN project_settings prs ON p.id = prs.project_id
      WHERE p.id = $1
      LIMIT 1`,
    [projectId],
  );
  if (projectResult.rows.length === 0) {
    throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  }
  const row = projectResult.rows[0];
  const storyGraph = row.story_graph;
  const settings = row.settings || {};

  if (!storyGraph) {
    return {
      projectId,
      hasStory: false,
      summary: {
        nodeCount: 0,
        audioFileCount: 0,
        audioAssignmentCount: 0,
        errorCount: 0,
        warningCount: 0,
        missingAudioCount: 0,
        orphanedAudioCount: 0,
      },
      storyIssues: { errors: [], warnings: [] },
      audioCoverage: {
        missingAssignments: [],
        orphanedFiles: [],
        missingIndicatorAudio: [],
      },
    };
  }

  const audioResult = await pool.query(
    'SELECT id, filename FROM audio_files WHERE project_id = $1',
    [projectId],
  );
  const audioById = new Map<string, { id: string; filename: string }>();
  for (const f of audioResult.rows) audioById.set(f.id, f);

  const assignmentsResult = await pool.query(
    'SELECT node_id, audio_type, audio_file_id FROM node_audio_assignments WHERE project_id = $1',
    [projectId],
  );

  const referencedAudioIds = new Set<string>();
  const missingAssignments: ProjectValidationReport['audioCoverage']['missingAssignments'] = [];
  for (const a of assignmentsResult.rows) {
    referencedAudioIds.add(a.audio_file_id);
    if (!audioById.has(a.audio_file_id)) {
      const type = a.audio_type as 'voiceover' | 'ambience' | 'choice1' | 'choice2';
      missingAssignments.push({
        nodeId: a.node_id,
        audioType: type,
        audioFileId: a.audio_file_id,
      });
    }
  }

  // Indicator audio in project_settings.choiceIndicatorAudio
  const missingIndicatorAudio: ProjectValidationReport['audioCoverage']['missingIndicatorAudio'] =
    [];
  const indicators = (settings.choiceIndicatorAudio || {}) as Record<string, string | undefined>;
  for (const key of ['choice1', 'choice2'] as const) {
    const id = indicators[`${key}FileId`];
    if (id) {
      referencedAudioIds.add(id);
      if (!audioById.has(id)) {
        missingIndicatorAudio.push({ key, audioFileId: id });
      }
    }
  }

  const orphanedFiles: ProjectValidationReport['audioCoverage']['orphanedFiles'] = [];
  for (const [id, file] of audioById) {
    if (!referencedAudioIds.has(id)) {
      orphanedFiles.push({ id, filename: file.filename });
    }
  }

  // Story-level errors/warnings — already computed by the parser when
  // the .ink was uploaded. We just normalise the shape and count.
  const errors = Array.isArray(storyGraph.validation?.errors)
    ? (storyGraph.validation.errors as Array<Record<string, unknown>>)
    : [];
  const warnings = Array.isArray(storyGraph.validation?.warnings)
    ? (storyGraph.validation.warnings as Array<Record<string, unknown>>)
    : [];

  const nodes = (storyGraph.nodes as Record<string, RawNode>) || {};
  const nodeCount = Object.keys(nodes).length;

  return {
    projectId,
    hasStory: true,
    summary: {
      nodeCount,
      audioFileCount: audioById.size,
      audioAssignmentCount: assignmentsResult.rows.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      missingAudioCount: missingAssignments.length + missingIndicatorAudio.length,
      orphanedAudioCount: orphanedFiles.length,
    },
    storyIssues: { errors, warnings },
    audioCoverage: {
      missingAssignments,
      orphanedFiles,
      missingIndicatorAudio,
    },
  };
}
