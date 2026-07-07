import { jest } from '@jest/globals';
import { validateProject } from '../project-validator.js';
import type { Pool } from 'pg';

// covered the route; covers the validator itself.
// The function fans out a handful of SELECTs against a Pool and
// composes a report — perfect target for a mocked-pool unit test.

function makePool(handlers: Array<(sql: string, params: unknown[]) => unknown>) {
  // Round-robin through the handlers in the order the validator
  // issues queries: project → audio_files → assignments. Each handler
  // returns an object with `rows` and (optionally) `rowCount`.
  let i = 0;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const fn = handlers[i++];
    if (!fn) throw new Error(`unexpected extra query (#${i}): ${sql.slice(0, 60)}`);
    return fn(sql, params ?? []);
  });
  return {
    pool: { query } as unknown as Pool,
    query,
  };
}

describe('validateProject', () => {
  it('throws 404 when the project does not exist', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    await expect(validateProject(pool, 'missing')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('returns hasStory:false for a project without a story_graph', async () => {
    const { pool } = makePool([
      () => ({ rows: [{ id: 'p1', story_graph: null, settings: null }] }),
    ]);
    const report = await validateProject(pool, 'p1');
    expect(report.hasStory).toBe(false);
    expect(report.summary.nodeCount).toBe(0);
    expect(report.storyIssues.errors).toEqual([]);
    expect(report.audioCoverage.missingAssignments).toEqual([]);
  });

  it('counts nodes + audio files when the story is present', async () => {
    const storyGraph = {
      nodes: {
        a: { audio: { voiceover: 'a.mp3' } },
        b: { audio: {} },
        c: { audio: {} },
      },
      validation: { errors: [], warnings: [] },
    };
    const { pool } = makePool([
      () => ({ rows: [{ id: 'p1', story_graph: storyGraph, settings: {} }] }),
      () => ({ rows: [{ id: 'f1', filename: 'a.mp3' }] }),
      () => ({ rows: [{ node_id: 'a', audio_type: 'voiceover', audio_file_id: 'f1' }] }),
    ]);
    const report = await validateProject(pool, 'p1');
    expect(report.summary.nodeCount).toBe(3);
    expect(report.summary.audioFileCount).toBe(1);
    expect(report.summary.audioAssignmentCount).toBe(1);
    expect(report.summary.missingAudioCount).toBe(0);
    expect(report.summary.orphanedAudioCount).toBe(0);
  });

  it('surfaces missing audio assignments when audio_file_id is dangling', async () => {
    const storyGraph = { nodes: { a: {} }, validation: { errors: [], warnings: [] } };
    const { pool } = makePool([
      () => ({ rows: [{ id: 'p1', story_graph: storyGraph, settings: {} }] }),
      () => ({ rows: [] }),
      () => ({
        rows: [
          { node_id: 'a', audio_type: 'voiceover', audio_file_id: 'deleted-1' },
          { node_id: 'a', audio_type: 'ambience', audio_file_id: 'deleted-2' },
        ],
      }),
    ]);
    const report = await validateProject(pool, 'p1');
    expect(report.summary.missingAudioCount).toBe(2);
    expect(report.audioCoverage.missingAssignments).toEqual([
      { nodeId: 'a', audioType: 'voiceover', audioFileId: 'deleted-1' },
      { nodeId: 'a', audioType: 'ambience', audioFileId: 'deleted-2' },
    ]);
  });

  it('surfaces orphaned audio files (not referenced by any assignment or indicator)', async () => {
    const storyGraph = { nodes: { a: {} }, validation: { errors: [], warnings: [] } };
    const { pool } = makePool([
      () => ({ rows: [{ id: 'p1', story_graph: storyGraph, settings: {} }] }),
      () => ({
        rows: [
          { id: 'used-id', filename: 'used.mp3' },
          { id: 'orphan-id', filename: 'orphan.mp3' },
        ],
      }),
      () => ({
        rows: [{ node_id: 'a', audio_type: 'voiceover', audio_file_id: 'used-id' }],
      }),
    ]);
    const report = await validateProject(pool, 'p1');
    expect(report.summary.orphanedAudioCount).toBe(1);
    expect(report.audioCoverage.orphanedFiles).toEqual([
      { id: 'orphan-id', filename: 'orphan.mp3' },
    ]);
  });

  it('flags choice-indicator audio that points at a deleted file', async () => {
    const storyGraph = { nodes: {}, validation: { errors: [], warnings: [] } };
    const settings = {
      choiceIndicatorAudio: { choice1FileId: 'ghost-1', choice2FileId: 'ghost-2' },
    };
    const { pool } = makePool([
      () => ({ rows: [{ id: 'p1', story_graph: storyGraph, settings }] }),
      () => ({ rows: [] }),
      () => ({ rows: [] }),
    ]);
    const report = await validateProject(pool, 'p1');
    expect(report.summary.missingAudioCount).toBe(2);
    expect(report.audioCoverage.missingIndicatorAudio).toEqual([
      { key: 'choice1', audioFileId: 'ghost-1' },
      { key: 'choice2', audioFileId: 'ghost-2' },
    ]);
  });

  it('does NOT mark a file orphaned when it is referenced only by indicator audio', async () => {
    const storyGraph = { nodes: {}, validation: { errors: [], warnings: [] } };
    const settings = { choiceIndicatorAudio: { choice1FileId: 'used' } };
    const { pool } = makePool([
      () => ({ rows: [{ id: 'p1', story_graph: storyGraph, settings }] }),
      () => ({ rows: [{ id: 'used', filename: 'click.mp3' }] }),
      () => ({ rows: [] }),
    ]);
    const report = await validateProject(pool, 'p1');
    expect(report.audioCoverage.orphanedFiles).toEqual([]);
    expect(report.audioCoverage.missingIndicatorAudio).toEqual([]);
  });

  it('passes through story-level errors and warnings verbatim', async () => {
    const storyGraph = {
      nodes: { a: {} },
      validation: {
        errors: [{ type: 'syntax_error', message: 'oops', lineNumber: 3 }],
        warnings: [{ type: 'orphaned_stitch', message: 'lonely', nodeId: 'a' }],
      },
    };
    const { pool } = makePool([
      () => ({ rows: [{ id: 'p1', story_graph: storyGraph, settings: {} }] }),
      () => ({ rows: [] }),
      () => ({ rows: [] }),
    ]);
    const report = await validateProject(pool, 'p1');
    expect(report.summary.errorCount).toBe(1);
    expect(report.summary.warningCount).toBe(1);
    expect(report.storyIssues.errors[0]).toMatchObject({ message: 'oops' });
    expect(report.storyIssues.warnings[0]).toMatchObject({ nodeId: 'a' });
  });
});
