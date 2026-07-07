import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupStaleBuilds,
  formatBuild,
  parseIntEnv,
  readPlayerBundleInfo,
  reconcileSoftDeletedBuilds,
  renderSmokeHtml,
  SOFT_DELETE_GRACE_HOURS,
} from '../build-service.js';
import type { BuildRecord } from '../build-service.js';
import type { Pool } from 'pg';

// integration tests for the build pipeline.
//
// The pipeline lives in build-service.ts and is dominated by executeBuild,
// which orchestrates filesystem + npm + vite + ffmpeg + the DB. Running it
// for real in a unit test is impractical (minutes per run, full toolchain).
// We cover the smaller pieces around it here:
//
//   - formatBuild: shape contract for API responses.
//   - cleanupStaleBuilds: server-restart recovery path (mocked pool).
//   - renderSmokeHtml: smoke runner baked into builds.
//
// The big-bang executeBuild integration check is covered live by Cypress
// (cypress/e2e/builds.cy.ts) — it exercises the real pipeline against the
// running stack. That's where the "produces valid artifacts" assertion
// lives; unit-testing it here would just retest the same code path with a
// worse signal-to-noise ratio.

describe('build-service unit', () => {
  describe('formatBuild', () => {
    const row: BuildRecord = {
      id: 'b1',
      project_id: 'p1',
      build_number: 3,
      status: 'completed',
      progress: 100,
      message: 'Build complete',
      error: null,
      label: 'rc-1',
      total_size_bytes: '1048576',
      audio_size_bytes: '524288',
      code_size_bytes: '524288',
      audio_file_count: 12,
      node_count: 45,
      artifact_path: 'builds/b1.zip',
      created_at: '2026-05-23T00:00:00.000Z',
      completed_at: '2026-05-23T00:01:00.000Z',
      created_by: 'u1',
      pinned: false,
      deleted_at: null,
    };

    it('coerces BIGINT-as-string fields to JS numbers', () => {
      const out = formatBuild(row);
      expect(out.totalSizeBytes).toBe(1048576);
      expect(out.audioSizeBytes).toBe(524288);
      expect(out.codeSizeBytes).toBe(524288);
      // Numeric-typed columns pass through.
      expect(out.audioFileCount).toBe(12);
      expect(out.nodeCount).toBe(45);
    });

    it('keeps null sizes as null', () => {
      const out = formatBuild({ ...row, total_size_bytes: null, audio_size_bytes: null });
      expect(out.totalSizeBytes).toBeNull();
      expect(out.audioSizeBytes).toBeNull();
    });

    it('round-trips non-size fields verbatim', () => {
      const out = formatBuild(row);
      expect(out).toMatchObject({
        id: 'b1',
        buildNumber: 3,
        status: 'completed',
        progress: 100,
        message: 'Build complete',
        error: null,
        label: 'rc-1',
        createdAt: '2026-05-23T00:00:00.000Z',
        completedAt: '2026-05-23T00:01:00.000Z',
      });
    });

    it('coerces malformed bigints (non-numeric strings) to null', () => {
      const out = formatBuild({ ...row, total_size_bytes: 'not-a-number' });
      expect(out.totalSizeBytes).toBeNull();
    });

    // pinning shape contract.
    it('exposes pinned=true when the row is pinned', () => {
      expect(formatBuild({ ...row, pinned: true }).pinned).toBe(true);
    });

    it('exposes pinned=false for unpinned rows', () => {
      expect(formatBuild(row).pinned).toBe(false);
    });

    it('coerces missing pinned column (pre-migration rows) to false', () => {
      // Rows loaded from a DB that hasn't run the migration
      // yet come back with pinned undefined; BuildRecord marks it
      // optional so the cast isn't needed here, and the shape
      // contract is that formatBuild always exposes a boolean.
      const { pinned: _ignored, ...rest } = row;
      expect(formatBuild(rest).pinned).toBe(false);
    });

    // player bundle identity fields flow through formatBuild.
    it('exposes playerBundleVersion + playerBundleSriHash when set on the row', () => {
      const out = formatBuild({
        ...row,
        player_bundle_version: '0.1.0-abc1234',
        player_bundle_sri_hash: 'sha384-testhashabc',
      });
      expect(out.playerBundleVersion).toBe('0.1.0-abc1234');
      expect(out.playerBundleSriHash).toBe('sha384-testhashabc');
    });

    it('exposes both bundle fields as null on earlier rows', () => {
      const out = formatBuild(row);
      expect(out.playerBundleVersion).toBeNull();
      expect(out.playerBundleSriHash).toBeNull();
    });
  });

  // reader for player-app/dist/bundle-info.json.
  describe('readPlayerBundleInfo', () => {
    let tmpDist: string;
    beforeEach(() => {
      tmpDist = mkdtempSync(join(tmpdir(), 'wanderline-bundle-info-'));
    });
    afterEach(() => {
      rmSync(tmpDist, { recursive: true, force: true });
    });

    function write(info: unknown) {
      writeFileSync(join(tmpDist, 'bundle-info.json'), JSON.stringify(info));
    }

    it('returns null when the file is absent', () => {
      // Fresh tmp dir; no bundle-info.json inside.
      expect(readPlayerBundleInfo(tmpDist)).toBeNull();
    });

    it('parses version + sriHash on a well-formed file', () => {
      write({
        version: '0.1.0-abc1234',
        buildTime: '2026-07-01T00:00:00.000Z',
        mainScript: 'assets/index-xyz.js',
        sriAlgorithm: 'sha384',
        sriHash: 'sha384-basestringhere',
        scripts: [],
      });
      expect(readPlayerBundleInfo(tmpDist)).toEqual({
        version: '0.1.0-abc1234',
        sriHash: 'sha384-basestringhere',
      });
    });

    it('returns null on invalid JSON', () => {
      writeFileSync(join(tmpDist, 'bundle-info.json'), '{not-json');
      expect(readPlayerBundleInfo(tmpDist)).toBeNull();
    });

    it('returns null when a required field is missing', () => {
      write({ version: '0.1.0-abc1234' }); // no sriHash
      expect(readPlayerBundleInfo(tmpDist)).toBeNull();
    });

    it('returns null when required fields are the wrong type', () => {
      write({ version: 42, sriHash: 'sha384-x' });
      expect(readPlayerBundleInfo(tmpDist)).toBeNull();
    });

    it('rejects blank / whitespace-only values', () => {
      write({ version: '   ', sriHash: '   ' });
      expect(readPlayerBundleInfo(tmpDist)).toBeNull();
    });

    it('trims surrounding whitespace on valid values', () => {
      // Defensive against a bundle-info emitter that trails a newline
      // or leading space into the value string.
      write({ version: '  0.1.0  ', sriHash: '  sha384-x  ' });
      expect(readPlayerBundleInfo(tmpDist)).toEqual({
        version: '0.1.0',
        sriHash: 'sha384-x',
      });
    });

    it('rejects an sriHash that is missing the expected algorithm prefix', () => {
      // If the emitter ever shipped sha512 or a bare hash, we don't
      // want it landing in the DB — the preview shell hands it to
      // <script integrity=...> unchanged and a wrong algorithm breaks
      // the whole integrity check.
      write({ version: '0.1.0', sriHash: 'sha512-abcdefg' });
      expect(readPlayerBundleInfo(tmpDist)).toBeNull();
      write({ version: '0.1.0', sriHash: 'abcdefgnoshavariant' });
      expect(readPlayerBundleInfo(tmpDist)).toBeNull();
    });
  });

  describe('cleanupStaleBuilds', () => {
    // jest.fn() with no generic infers () => never under strict TS,
    // which makes mockResolvedValue / mockRejectedValue 2345 here.
    // Type the mock fn as Pool['query'] so the rest of the test stays
    // tight.
    type PoolQuery = Pool['query'];
    function makePool(rows: Array<{ id: string }>) {
      const query = jest.fn<PoolQuery>().mockResolvedValue({ rows } as never);
      return { pool: { query } as unknown as Pool, query };
    }

    it('marks pending + processing builds as failed', async () => {
      const { pool, query } = makePool([{ id: 'b1' }, { id: 'b2' }]);
      await cleanupStaleBuilds(pool);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql] = query.mock.calls[0];
      expect(sql).toMatch(/UPDATE project_builds/);
      expect(sql).toMatch(/status\s*=\s*'failed'/);
      expect(sql).toMatch(/status IN\s*\(\s*'pending',\s*'processing'\s*\)/);
    });

    it('does not throw when no stale builds are found', async () => {
      const { pool } = makePool([]);
      await expect(cleanupStaleBuilds(pool)).resolves.toBeUndefined();
    });

    it('swallows DB failures so server startup is not blocked', async () => {
      const query = jest
        .fn<PoolQuery>()
        .mockRejectedValue(new Error('connection refused') as never);
      const pool = { query } as unknown as Pool;
      // The cleanup is best-effort — it must NOT reject and abort startup.
      await expect(cleanupStaleBuilds(pool)).resolves.toBeUndefined();
    });
  });

  // reconciliation sweep for soft-deleted builds.
  describe('reconcileSoftDeletedBuilds', () => {
    type PoolQuery = Pool['query'];

    // Helper: the sweep issues 1 SELECT then 1 guarded DELETE per row
    // (the DELETE returns artifact_path via RETURNING). The mock lets
    // callers describe the DELETE outcomes so we can exercise the
    // "guard failed → 0 rows returned → no external cleanup" branch.
    function makePool(
      selectRows: Array<{ id: string }>,
      deleteOutcomes: Array<{ rows: Array<{ artifact_path: string | null }> } | Error> = [],
    ) {
      let deleteIdx = 0;
      const query = jest.fn<PoolQuery>().mockImplementation((async (sql: string) => {
        if (/^\s*SELECT/i.test(sql)) return { rows: selectRows } as never;
        if (/^\s*DELETE/i.test(sql)) {
          const outcome = deleteOutcomes[deleteIdx++];
          if (outcome instanceof Error) throw outcome;
          // Default: guarded DELETE removes the row, no artifact path.
          return (outcome ?? { rows: [{ artifact_path: null }], rowCount: 1 }) as never;
        }
        throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
      }) as unknown as PoolQuery['bind']);
      return { pool: { query } as unknown as Pool, query };
    }

    it('scopes the sweep to soft-deleted, unpinned rows past the grace window', async () => {
      const { pool, query } = makePool([]);
      await reconcileSoftDeletedBuilds(pool);
      const [sql, params] = query.mock.calls[0];
      // Predicate contract — the sweep never touches non-deleted rows
      // (deleted_at IS NULL), pinned rows (pinned = FALSE), or rows
      // inside the grace window (interval driven by
      // SOFT_DELETE_GRACE_HOURS).
      expect(sql).toMatch(/SELECT[\s\S]*FROM project_builds/);
      expect(sql).toMatch(/deleted_at IS NOT NULL/);
      expect(sql).toMatch(/pinned\s*=\s*FALSE/);
      // make_interval(hours => $1::int) — parameterised, no string
      // concatenation of user-tunable values into interval literals.
      expect(sql).toMatch(/NOW\(\)\s*-\s*make_interval\(hours\s*=>\s*\$1::int\)/);
      expect(params).toEqual([SOFT_DELETE_GRACE_HOURS]);
    });

    it('hard-deletes each returned row from the table with a guarded DELETE', async () => {
      const { pool, query } = makePool([{ id: 'b1' }, { id: 'b2' }]);
      await reconcileSoftDeletedBuilds(pool);
      // 1 SELECT + 2 DELETEs (one per row).
      expect(query).toHaveBeenCalledTimes(3);
      const deleteCalls = query.mock.calls.filter(([sql]) => /^\s*DELETE/i.test(sql));
      expect(deleteCalls).toHaveLength(2);
      // Each DELETE targets the specific row by id AND re-checks the
      // soft-deleted + unpinned invariant inside the same statement,
      // AND uses RETURNING artifact_path so cleanup uses the DB's
      // authoritative path (not the stale one from the sweep's SELECT).
      // This is the TOCTOU guard: if a future restore path clears
      // deleted_at (or a user pins the row) between the sweep's SELECT
      // and this DELETE, the guarded DELETE returns 0 rows and we
      // don't touch external state.
      expect(deleteCalls[0][0]).toMatch(/DELETE FROM project_builds/);
      expect(deleteCalls[0][0]).toMatch(/id = \$1/);
      expect(deleteCalls[0][0]).toMatch(/deleted_at IS NOT NULL/);
      expect(deleteCalls[0][0]).toMatch(/pinned\s*=\s*FALSE/);
      expect(deleteCalls[0][0]).toMatch(/RETURNING artifact_path/);
      expect(deleteCalls[0][1]).toEqual(['b1']);
      expect(deleteCalls[1][1]).toEqual(['b2']);
    });

    it('skips external cleanup when the guarded DELETE returns no rows (restore race)', async () => {
      // Row was in the SELECT snapshot but got restored / pinned before
      // hardDeleteBuild ran; the guarded DELETE returns rowCount 0. The
      // sweep must NOT touch storage or the preview cache for that row.
      const { pool, query } = makePool([{ id: 'b1' }], [{ rows: [] }]);
      await reconcileSoftDeletedBuilds(pool);
      // Exactly 1 SELECT + 1 DELETE + no other calls (no storage/cache).
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the sweep returns no rows', async () => {
      const { pool, query } = makePool([]);
      await reconcileSoftDeletedBuilds(pool);
      // Only the SELECT — no DELETEs should fire.
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('swallows DB failures so server startup is not blocked', async () => {
      const query = jest
        .fn<PoolQuery>()
        .mockRejectedValue(new Error('connection refused') as never);
      const pool = { query } as unknown as Pool;
      // Best-effort — must NOT reject.
      await expect(reconcileSoftDeletedBuilds(pool)).resolves.toBeUndefined();
    });

    it('logs and continues when a single row cleanup fails', async () => {
      // First DELETE fails; second succeeds. The sweep should still
      // return normally so a wedged row doesn't stop the batch.
      const { pool, query } = makePool(
        [{ id: 'bad' }, { id: 'b1' }],
        [new Error('row is wedged'), { rows: [{ artifact_path: null }] }],
      );
      await expect(reconcileSoftDeletedBuilds(pool)).resolves.toBeUndefined();
      // 1 SELECT + 2 DELETE attempts (the first threw, the sweep still
      // called the second).
      const deleteCalls = query.mock.calls.filter(([sql]) => /^\s*DELETE/i.test(sql));
      expect(deleteCalls).toHaveLength(2);
    });
  });

  describe('renderSmokeHtml', () => {
    const sampleStory = {
      id: 'story1',
      title: 'Hello & <world>',
      audioBaseUrl: './audio/',
      startNode: 'start',
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [],
          choices: [{ text: 'go', target: 'next' }],
          divert: null,
          tags: [],
          audio: { voiceover: 'vo.mp3' },
        },
        next: {
          id: 'next',
          type: 'knot',
          content: [],
          choices: [],
          divert: 'END',
          tags: [],
          audio: {},
        },
      },
    };

    it('renders a self-contained HTML document', () => {
      const html = renderSmokeHtml(sampleStory);
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).toMatch(/<\/html>\s*$/);
      expect(html).toMatch(/<title>[^<]*— smoke test<\/title>/);
    });

    it('inlines the story payload as window.__WANDERLINE_STORY__', () => {
      const html = renderSmokeHtml(sampleStory);
      expect(html).toMatch(/window\.__WANDERLINE_STORY__\s*=\s*\{/);
      // Story id appears in the payload literal, so a substring check is enough.
      expect(html).toMatch(/"id":"story1"/);
    });

    it('html-escapes the story title when used in <title>', () => {
      const html = renderSmokeHtml(sampleStory);
      const titleMatch = /<title>([^<]*)<\/title>/.exec(html);
      expect(titleMatch).not.toBeNull();
      // Source title is "Hello & <world>" — both meta-chars must be
      // escaped. The < gets converted into &lt; before reaching
      // <title>, hence the regex above won't even capture a raw <.
      expect(titleMatch![1]).toContain('&amp;');
      expect(titleMatch![1]).toContain('&lt;');
      expect(titleMatch![1]).toContain('&gt;');
      // And the raw `<world>` must not appear in the rendered <title>.
      expect(titleMatch![1]).not.toContain('<world>');
    });

    it('breaks any </script> sequence inside the inlined story data', () => {
      const story = { ...sampleStory, title: 'a</script>b' };
      const html = renderSmokeHtml(story);
      // The inlined JSON should escape `<` to < so a malicious story
      // title can't close the embedded <script> early.
      const scriptBody = html.split('window.__WANDERLINE_STORY__')[1].split('</script>')[0];
      expect(scriptBody).not.toMatch(/<\/script>/i);
      expect(scriptBody).toMatch(/\\u003c\\\/script\\u003e|\\u003c\/script>/i);
    });

    it('declares the three smoke checks in the embedded runner', () => {
      const html = renderSmokeHtml(sampleStory);
      expect(html).toMatch(/Every node has content, a divert, or choices/);
      expect(html).toMatch(/Every divert \/ choice target resolves/);
      expect(html).toMatch(/Every referenced audio file is reachable/);
    });

    it('handles a story with no nodes without throwing', () => {
      const empty = { id: 'e', title: 'Empty', audioBaseUrl: './audio/', startNode: '', nodes: {} };
      const html = renderSmokeHtml(empty);
      expect(html).toMatch(/window\.__WANDERLINE_STORY__/);
    });
  });

  // env-var integer parsing with fallback + clamp.
  // Consumers today are MAX_BUILDS_PER_PROJECT (via BUILD_RETENTION)
  // and pg.Pool's max (via POOL_MAX in index.ts). Locking the
  // fallback + clamp behaviour prevents a `BUILD_RETENTION=abc`
  // misconfig from producing a NaN cap or a `POOL_MAX=0` from
  // producing a zero-slot pool.
  describe('parseIntEnv', () => {
    const KEY = 'WANDERLINE_TEST_ENV';
    afterEach(() => {
      delete process.env[KEY];
    });

    it('returns the fallback when the env var is unset', () => {
      delete process.env[KEY];
      expect(parseIntEnv(KEY, 3)).toBe(3);
    });

    it('returns the fallback when the env var is empty', () => {
      process.env[KEY] = '';
      expect(parseIntEnv(KEY, 3)).toBe(3);
    });

    it('returns the fallback when the env var is not a valid integer', () => {
      // parseInt would silently return NaN here; the helper must
      // absorb it rather than let it flow downstream.
      for (const bad of ['abc', 'not-a-number', 'NaN', 'undefined']) {
        process.env[KEY] = bad;
        expect(parseIntEnv(KEY, 3)).toBe(3);
      }
    });

    it('returns the parsed value when it is a valid integer above the min', () => {
      process.env[KEY] = '7';
      expect(parseIntEnv(KEY, 3)).toBe(7);
    });

    it('clamps a below-min value up to the min (default 1)', () => {
      // `BUILD_RETENTION=0` or a stray `-5` shouldn't quietly
      // disable retention — the clamp lifts them to 1.
      process.env[KEY] = '0';
      expect(parseIntEnv(KEY, 3)).toBe(1);
      process.env[KEY] = '-5';
      expect(parseIntEnv(KEY, 3)).toBe(1);
    });

    it('honours a custom min when passed', () => {
      process.env[KEY] = '2';
      expect(parseIntEnv(KEY, 10, 5)).toBe(5);
      process.env[KEY] = '7';
      expect(parseIntEnv(KEY, 10, 5)).toBe(7);
    });

    it('parses leading-integer values the way parseInt does (accepts trailing garbage)', () => {
      // parseInt('10abc') === 10 — surprising but documented; the
      // helper stays consistent with it. Locked in so a future
      // "tighten to strict integer" refactor is an explicit choice
      // rather than an accidental behaviour change.
      process.env[KEY] = '10abc';
      expect(parseIntEnv(KEY, 3)).toBe(10);
    });
  });
});
