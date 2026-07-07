import { Router, Request, Response, RequestHandler } from 'express';
import { Pool } from 'pg';
import { pipeline } from 'stream/promises';
import {
  executeBuild,
  formatBuild,
  IDEMPOTENCY_WINDOW_DAYS,
  MAX_BUILDS_PER_PROJECT,
} from '../services/build-service.js';
import {
  getStorage,
  isStorageKey,
  audioKey,
  IMMUTABLE_AUDIO_CACHE_CONTROL,
  useSignedUrlDownloads,
} from '../services/storage.js';
import { storyHash, useBuildDedup } from '../services/story-hash.js';
import { resolveBuildPreviewAudio } from '../services/build-preview-audio.js';
import {
  applyPreviewHeaders,
  generatePreviewNonce,
  renderPreviewHtml,
} from './projects-preview.js';
import { createReadStream as fsCreateReadStream, statSync as fsStatSync } from 'fs';
import { extname as pathExtname } from 'path';
import { logger } from '../logger.js';
import { createReadStream, existsSync } from 'fs';

export function mountBuildRoutes(
  router: Router,
  pool: Pool,
  options: { postLimiter?: RequestHandler } = {},
): void {
  // rate limit on the enqueue endpoint. When mounted from
  // index.ts we pass buildEnqueueLimiter; tests pass noopLimiter or
  // leave it undefined so they can drive the handler directly. The
  // no-op fallback keeps the mount site backwards-compat with any
  // caller that doesn't know about the limiter (e.g. older test
  // helpers) — the real production wiring always provides one.
  const postLimiter: RequestHandler = options.postLimiter ?? ((_req, _res, next) => next());

  /**
   * @openapi
   * /projects/{id}/builds:
   *   get:
   *     summary: List builds for a project (newest first).
   *     tags: [Builds]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Build list + creation gating flags.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 builds:
   *                   type: array
   *                   items: { $ref: '#/components/schemas/Build' }
   *                 maxBuilds: { type: integer }
   *                 canCreateBuild: { type: boolean }
   */
  router.get('/:id/builds', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // soft-deleted rows are hidden from the list + don't count
      // toward the cap. They're reaped 24h after deletion by
      // reconcileSoftDeletedBuilds.
      const result = await pool.query(
        `SELECT * FROM project_builds WHERE project_id = $1 AND deleted_at IS NULL ORDER BY build_number DESC`,
        [id],
      );

      const builds = result.rows.map(formatBuild);
      const activeCount = result.rows.filter(
        (r) => r.status === 'pending' || r.status === 'processing',
      ).length;

      res.json({
        builds,
        maxBuilds: MAX_BUILDS_PER_PROJECT,
        canCreateBuild: result.rows.length < MAX_BUILDS_PER_PROJECT && activeCount === 0,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to list builds');
      res.status(500).json({ error: 'Failed to list builds' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/builds/{buildId}:
   *   get:
   *     summary: Get a build's status / details.
   *     tags: [Builds]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: buildId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Build detail.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 build:
   *                   allOf:
   *                     - $ref: '#/components/schemas/Build'
   *                     - type: object
   *                       properties:
   *                         downloadUrl: { type: string, nullable: true }
   *       404: { description: Build not found for this project. }
   */
  router.get('/:id/builds/:buildId', async (req: Request, res: Response) => {
    try {
      const { id, buildId } = req.params;

      // hide soft-deleted rows — the row still exists during
      // the 24h grace window but callers should see 404 (there's a
      // separate admin/restore surface planned).
      const result = await pool.query(
        `SELECT * FROM project_builds WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [buildId, id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Build not found' });
        return;
      }

      const build = formatBuild(result.rows[0]);
      res.json({
        build: {
          ...build,
          downloadUrl:
            build.status === 'completed'
              ? `/api/projects/${id}/builds/${buildId}/download`
              : undefined,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get build');
      res.status(500).json({ error: 'Failed to get build' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/builds:
   *   post:
   *     summary: Start a new build (async).
   *     description: |
   *       Returns 202 + the queued build row; the pipeline runs in the
   *       background and writes status updates back to the same row.
   *       Refuses if another build is already in progress (409).
   *
   *       Idempotency: pass `Idempotency-Key` header (≤128 chars, no
   *       whitespace-only) to make retries deterministic. Within the
   *       IDEMPOTENCY_WINDOW_DAYS window, a same-key retry from the
   *       same session user returns the existing row (200 +
   *       X-Wanderline-Idempotent: hit) instead of enqueuing a new
   *       build. Keys are scoped per (project, user) — a collaborator
   *       cannot dedup to another user's keyed build.
   *
   *       Retention: when the project is at MAX_BUILDS_PER_PROJECT,
   *       the oldest non-pinned completed/failed build is soft-deleted
   *       to make room. If EVERY existing build is pinned or in-flight,
   *       the request 400s with "unpin one first".
   *     tags: [Builds]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: header
   *         name: Idempotency-Key
   *         required: false
   *         schema: { type: string, maxLength: 128 }
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               label: { type: string, maxLength: 255 }
   *     responses:
   *       200:
   *         description: Dedup or idempotent hit (existing build returned).
   *       202:
   *         description: Queued.
   *       400: { description: No story, malformed key, or all builds pinned. }
   *       404: { description: Project not found. }
   *       409: { description: A build is already in progress. }
   *       429: { description: Rate limit exceeded. }
   */
  router.post('/:id/builds', postLimiter, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { label } = req.body || {};
      const userId = req.session?.userId;

      // Validate label
      const trimmedLabel = typeof label === 'string' ? label.trim().slice(0, 255) : null;

      // extract Idempotency-Key. Accept only ≤128 non-blank
      // chars — matches the DB column width + the plan's contract
      // (whitespace-only keys are ambiguous, reject at the boundary).
      const rawIdempotencyKey = req.header('Idempotency-Key');
      let idempotencyKey: string | null = null;
      if (rawIdempotencyKey !== undefined) {
        const trimmed = rawIdempotencyKey.trim();
        if (!trimmed || trimmed.length > 128) {
          res.status(400).json({
            error: 'Idempotency-Key must be 1-128 non-whitespace characters',
          });
          return;
        }
        idempotencyKey = trimmed;
      }

      // Verify project has a story
      const projectResult = await pool.query(
        `SELECT p.id, ps.story_graph FROM projects p LEFT JOIN project_stories ps ON p.id = ps.project_id WHERE p.id = $1`,
        [id],
      );

      if (projectResult.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      if (!projectResult.rows[0].story_graph) {
        res.status(400).json({ error: 'Project has no story. Upload an Ink file first.' });
        return;
      }

      // Use a transaction with row locking to prevent race conditions
      const client = await pool.connect();
      let insertResult;
      // Optional dedup outcome we hand back to the response block
      // after committing / rolling back. Populated inside the txn so
      // the response write itself is decoupled from DB work.
      let dedupBuild: ReturnType<typeof formatBuild> | null = null;
      let dedupHash: string | null = null;
      let idempotentBuild: ReturnType<typeof formatBuild> | null = null;
      let autoCulledBuildId: string | null = null;
      try {
        await client.query('BEGIN');

        // Advisory lock keyed on project ID to prevent concurrent build creation
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [id]);

        // Idempotency-Key lookup runs FIRST — same key from
        // the same user within the window replays the same result.
        // Scope UNIQUE constraint at the DB level is
        // (project_id, created_by, idempotency_key); we enforce the
        // 7-day window in code by filtering created_at.
        if (idempotencyKey && userId) {
          const idempotentResult = await client.query(
            `SELECT id, project_id, build_number, status, progress, message, error,
                    label, total_size_bytes, audio_size_bytes, code_size_bytes,
                    audio_file_count, node_count, artifact_path, created_at,
                    completed_at, created_by, pinned, deleted_at,
                    player_bundle_version, player_bundle_sri_hash
               FROM project_builds
               WHERE project_id = $1
                 AND created_by = $2
                 AND idempotency_key = $3
                 AND created_at > NOW() - make_interval(days => $4::int)
                 AND deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT 1`,
            [id, userId, idempotencyKey, IDEMPOTENCY_WINDOW_DAYS],
          );
          if (idempotentResult.rows.length > 0) {
            idempotentBuild = formatBuild(idempotentResult.rows[0]);
            await client.query('COMMIT');
          }
        }

        if (!idempotentBuild) {
          // Check for active builds. Soft-deleted rows can't be active
          // (soft-delete only touches completed/failed rows), but the
          // AND deleted_at IS NULL keeps this consistent with the cap
          // + list queries above.
          const activeResult = await client.query(
            `SELECT id FROM project_builds WHERE project_id = $1 AND status IN ('pending', 'processing') AND deleted_at IS NULL`,
            [id],
          );
          if (activeResult.rows.length > 0) {
            await client.query('ROLLBACK');
            res.status(409).json({
              error: 'A build is already in progress for this project',
              buildId: activeResult.rows[0].id,
            });
            return;
          }

          // retention auto-cull. Previously the enqueue
          // returned 400 when at MAX_BUILDS_PER_PROJECT and forced the
          // caller to manually delete a build. Now we soft-delete the
          // oldest non-pinned completed/failed row automatically —
          // the deleted_at row still sits in the 24h grace window
          // (recoverable via a future admin endpoint), and pinned
          // builds are never touched. If EVERY existing build is
          // pinned (or the cap is somehow hit by only in-flight rows,
          // impossible in practice thanks to the active check above),
          // fail with a clear "unpin one first" message.
          const countResult = await client.query(
            `SELECT COUNT(*) as count FROM project_builds WHERE project_id = $1 AND deleted_at IS NULL`,
            [id],
          );
          if (parseInt(countResult.rows[0].count, 10) >= MAX_BUILDS_PER_PROJECT) {
            const cullCandidate = await client.query(
              `SELECT id FROM project_builds
                 WHERE project_id = $1
                   AND deleted_at IS NULL
                   AND pinned = FALSE
                   AND status IN ('completed', 'failed', 'cancelled')
                 ORDER BY completed_at ASC NULLS FIRST, created_at ASC
                 LIMIT 1`,
              [id],
            );
            if (cullCandidate.rows.length === 0) {
              await client.query('ROLLBACK');
              res.status(400).json({
                error: `Maximum ${MAX_BUILDS_PER_PROJECT} builds per project and every build is pinned. Unpin one first.`,
              });
              return;
            }
            // Re-check the invariant inside the UPDATE. The advisory
            // xact lock above guards against concurrent build
            // creation on this project, but pin / soft-delete come
            // through OTHER handlers and don't hold that lock — a
            // concurrent pin between SELECT and UPDATE would otherwise
            // let us soft-delete a freshly pinned build. RETURNING id
            // + a zero-row check surfaces the race as an explicit 400
            // rather than silently doing the wrong thing.
            const cullUpdate = await client.query(
              `UPDATE project_builds
                  SET deleted_at = NOW(), pinned = FALSE
                WHERE id = $1
                  AND pinned = FALSE
                  AND deleted_at IS NULL
                RETURNING id`,
              [cullCandidate.rows[0].id],
            );
            if (cullUpdate.rows.length === 0) {
              await client.query('ROLLBACK');
              res.status(409).json({
                error:
                  'The build we picked to make room was just pinned or deleted by another request. Retry.',
              });
              return;
            }
            autoCulledBuildId = cullUpdate.rows[0].id;
          }

          // story-hash dedup lookup runs after the active-build
          // check and the retention cull, so a currently-in-flight
          // build still wins 409 (the existing contract) and no TOCTOU
          // on deleted_at can leak a row that's about to be reaped.
          // Scope note (slice 1): the hash covers ONLY the story
          // graph, NOT audio_files, NOT project settings.
          // USE_BUILD_DEDUP defaults off so an audio- or settings-only
          // edit doesn't silently dedup to a stale artifact.
          if (useBuildDedup()) {
            const currentStoryHash = storyHash(projectResult.rows[0].story_graph);
            const dedupResult = await client.query(
              `SELECT id, project_id, build_number, status, progress, message, error,
                      label, total_size_bytes, audio_size_bytes, code_size_bytes,
                      audio_file_count, node_count, artifact_path, created_at,
                      completed_at, created_by, pinned, deleted_at,
                      player_bundle_version, player_bundle_sri_hash,
                      story_snapshot_hash
                 FROM project_builds
                 WHERE project_id = $1
                   AND story_snapshot_hash = $2
                   AND status = 'completed'
                   AND deleted_at IS NULL
                 ORDER BY completed_at DESC
                 LIMIT 1`,
              [id, currentStoryHash],
            );
            if (dedupResult.rows.length > 0) {
              dedupBuild = formatBuild(dedupResult.rows[0]);
              dedupHash = currentStoryHash;
            }
          }

          if (!dedupBuild) {
            // Get next build number and insert atomically. Include
            // idempotency_key so a same-key retry within the window
            // finds this row on the next request.
            const numberResult = await client.query(
              `SELECT COALESCE(MAX(build_number), 0) + 1 as next FROM project_builds WHERE project_id = $1`,
              [id],
            );
            const buildNumber = numberResult.rows[0].next;

            insertResult = await client.query(
              `INSERT INTO project_builds
                 (project_id, build_number, label, created_by, message, idempotency_key)
               VALUES ($1, $2, $3, $4, 'Queued for generation', $5)
               RETURNING *`,
              [id, buildNumber, trimmedLabel || null, userId || null, idempotencyKey],
            );
          }

          await client.query('COMMIT');
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      if (autoCulledBuildId) {
        // Structured event so an operator dashboard can chart auto-cull
        // frequency without parsing free-text log messages.
        req.log.info(
          { event: 'build.retention.autocull', projectId: id, buildId: autoCulledBuildId },
          ': auto-culled oldest non-pinned build to make room',
        );
      }

      if (idempotentBuild) {
        req.log.info(
          { event: 'build.idempotent.hit', buildId: idempotentBuild.id, projectId: id },
          ': Idempotency-Key hit — replaying existing build',
        );
        res.setHeader('X-Wanderline-Idempotent', 'hit');
        res.setHeader('Cache-Control', 'no-store, private');
        res.status(200).json({ build: idempotentBuild });
        return;
      }

      if (dedupBuild) {
        req.log.info(
          { event: 'build.dedup.hit', buildId: dedupBuild.id, projectId: id, hash: dedupHash },
          ': build dedup hit — returning existing completed build',
        );
        res.setHeader('X-Wanderline-Dedup', 'story-hash-match');
        res.setHeader('Cache-Control', 'no-store, private');
        res.status(200).json({ build: dedupBuild });
        return;
      }

      const build = formatBuild(insertResult!.rows[0]);

      req.log.info(
        { event: 'build.queued', buildId: build.id, projectId: id, buildNumber: build.buildNumber },
        'Build queued',
      );

      // Start async build. Builds can run for minutes, so we deliberately
      // do NOT close over `req` here — that would pin the whole
      // request/response in memory until the build settles. Use the
      // module logger with explicit context instead.
      executeBuild(pool, id, build.id).catch((err) => {
        logger.error(
          { event: 'build.failed', err, projectId: id, buildId: build.id },
          'Build execution failed',
        );
      });

      res.status(202).json({ build });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to start build');
      res.status(500).json({ error: 'Failed to start build' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/builds/{buildId}/download:
   *   get:
   *     summary: Stream the zipped build artifact.
   *     tags: [Builds]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: buildId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Zip stream.
   *         content:
   *           application/zip:
   *             schema: { type: string, format: binary }
   *       400: { description: Build is not yet completed. }
   *       404: { description: Build not found. }
   *       410: { description: Artifact was deleted or evicted from storage. }
   */
  router.get('/:id/builds/:buildId/download', async (req: Request, res: Response) => {
    try {
      const { id, buildId } = req.params;

      // soft-deleted rows can't be downloaded during the grace
      // window — the artifact still sits on disk / in storage but the
      // build is "gone" from the user's perspective.
      const result = await pool.query(
        `SELECT pb.*, p.name as project_name FROM project_builds pb
         JOIN projects p ON p.id = pb.project_id
         WHERE pb.id = $1 AND pb.project_id = $2 AND pb.deleted_at IS NULL`,
        [buildId, id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Build not found' });
        return;
      }

      const build = result.rows[0];

      if (build.status !== 'completed' || !build.artifact_path) {
        res.status(400).json({ error: 'Build not ready for download' });
        return;
      }

      // when the feature flag is on AND the backend supports
      // signed URLs (i.e. GCS, not local dev), redirect straight to a
      // 10-min V4 signed URL so the artifact bytes never flow through
      // Cloud Run. Per the ObjectStorage.signedGetUrl contract:
      //   - null → the backend structurally doesn't support signing
      //     (LocalStorage dev backend). Fall through to streaming.
      //   - throws → signing itself failed (auth misconfig, IAM, GCS
      //     unreachable). Log a warn with buildId + key so ops can
      //     triage, then degrade to streaming — the stream at least
      //     gets bytes to the client while we sort out signing.
      // Missing objects DO get URLs signed here; the client following
      // the URL sees a 404 from GCS. If we ever need the API's own
      // 410 JSON shape on missing objects, the pre-check goes here.
      if (useSignedUrlDownloads() && isStorageKey(build.artifact_path)) {
        try {
          const signedUrl = await getStorage().signedGetUrl(build.artifact_path);
          if (signedUrl) {
            // Cache-Control MUST be set before the redirect. Signed URLs
            // are per-request capabilities scoped to the caller; a CDN /
            // shared proxy / browser bfcache that stores this 307 would
            // hand the URL to a different authed user hitting the same
            // /download path. no-store + private slams every cache layer.
            res.setHeader('Cache-Control', 'no-store, private');
            // 307 preserves the GET method + is the recommended redirect
            // status for signed-URL handoffs (302 also works, but 307 is
            // less ambiguous about the semantics).
            res.redirect(307, signedUrl);
            return;
          }
        } catch (err) {
          req.log.warn(
            { err, buildId: build.id, key: build.artifact_path },
            'signedGetUrl threw — falling through to stream',
          );
        }
      }

      // Open the source first (storage or legacy disk) so we don't set zip
      // headers on a 410 JSON response.
      let stream: NodeJS.ReadableStream;
      if (isStorageKey(build.artifact_path)) {
        try {
          stream = await getStorage().downloadStream(build.artifact_path);
        } catch (err) {
          req.log.warn({ err }, 'Build artifact missing in storage');
          res.status(410).json({ error: 'Build artifact expired or deleted' });
          return;
        }
      } else if (existsSync(build.artifact_path)) {
        stream = createReadStream(build.artifact_path);
      } else {
        res.status(410).json({ error: 'Build artifact expired or deleted' });
        return;
      }

      const safeName = build.project_name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}_build${build.build_number}.zip"`,
      );
      await pipeline(stream, res);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to download build');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download build' });
      }
    }
  });

  /**
   * @openapi
   * /projects/{id}/builds/{buildId}/preview:
   *   get:
   *     summary: Per-build preview HTML.
   *     description: |
   *       Renders the player against the story_snapshot saved at build
   *       completion time. Audio falls back to the project's current
   *       audio_files; deleted-since-build clips 404 silently but the
   *       story still plays. Older builds without a snapshot return 409.
   *     tags: [Builds]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: buildId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Player HTML.
   *         content:
   *           text/html:
   *             schema: { type: string }
   *       404: { description: Build not found for that project. }
   *       409: { description: Build has no story_snapshot (earlier or in-progress). }
   */
  // — Per-build preview. Replays the player against the story
  // snapshot saved at build-completion time, so authors can spot-check
  // a historical build instead of always previewing the latest project
  // state. Audio is still resolved against the current project's
  // audio_files (see /preview/audio handler below) — deleted-since-
  // build audio will 404 in the preview but the story still plays.
  router.get('/:id/builds/:buildId/preview', async (req: Request, res: Response) => {
    try {
      const { id, buildId } = req.params;
      // soft-deleted rows aren't previewable during the grace
      // window.
      // pull player_bundle_sri_hash so the preview can pin
      // the integrity attribute to whichever bundle THIS build
      // shipped against — matters once versioned bundles land in GCS.
      // Today all builds ship against the container's baked-in dist,
      // so this value matches the current bundle for any build ≥
      //; earlier rows carry null and the preview falls
      // back to the current bundle's SRI.
      const result = await pool.query(
        `SELECT pb.story_snapshot, pb.status, pb.build_number, pb.label,
                pb.player_bundle_sri_hash,
                p.name as project_name
         FROM project_builds pb
         JOIN projects p ON p.id = pb.project_id
         WHERE pb.id = $1 AND pb.project_id = $2 AND pb.deleted_at IS NULL`,
        [buildId, id],
      );
      if (result.rows.length === 0) {
        res.status(404).send('Build not found');
        return;
      }
      const row = result.rows[0];
      if (row.status !== 'completed' || !row.story_snapshot) {
        // Builds that completed earlier don't have a
        // snapshot; treat them like in-progress builds for preview.
        res.status(409).send('This build has no preview snapshot available');
        return;
      }

      // Override the snapshot's top-level audioBaseUrl to point at the
      // per-build audio route — story-data-builder centralises the base
      // path here, so a shallow spread is enough. (Earlier versions
      // deep-cloned via JSON.parse(JSON.stringify(...)) which is O(size
      // of story) per request and got expensive for large graphs.)
      const buildAudioBase = `/api/projects/${id}/builds/${buildId}/preview/audio/`;
      const snapshot = {
        ...(row.story_snapshot as Record<string, unknown>),
        audioBaseUrl: buildAudioBase,
      };

      const banner = row.label
        ? `Build #${row.build_number} — ${row.label}`
        : `Build #${row.build_number}`;
      const nonce = generatePreviewNonce();
      const html = renderPreviewHtml(
        snapshot,
        `${row.project_name} — ${banner}`,
        banner,
        nonce,
        row.player_bundle_sri_hash ?? null,
      );
      applyPreviewHeaders(res, nonce);
      res.send(html);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to render build preview');
      res.status(500).send('Failed to render build preview');
    }
  });

  // + — audio for per-build preview. Tries the build's
  // artifact zip first (faithful snapshot, including WAV→MP3
  // conversions done at build time). Falls back to the project's
  // current audio_files row when the file isn't in the zip — that
  // handles builds created earlier. Returns 404 only
  // when both sources miss.
  router.get(
    '/:id/builds/:buildId/preview/audio/:filename',
    async (req: Request, res: Response) => {
      try {
        const { id, buildId, filename } = req.params;
        // soft-deleted build → no preview audio during grace window.
        const buildExists = await pool.query(
          `SELECT 1 FROM project_builds WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL LIMIT 1`,
          [buildId, id],
        );
        if (buildExists.rows.length === 0) {
          res.status(404).json({ error: 'Build not found' });
          return;
        }

        // Pass 1: serve from the cached zip extraction (true snapshot).
        const cached = await resolveBuildPreviewAudio(pool, buildId, filename);
        if (cached) {
          const stat = fsStatSync(cached);
          const ext = pathExtname(filename).toLowerCase();
          const mime =
            ext === '.mp3'
              ? 'audio/mpeg'
              : ext === '.wav'
                ? 'audio/wav'
                : ext === '.ogg'
                  ? 'audio/ogg'
                  : 'application/octet-stream';
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Length', stat.size);
          // Build-preview audio URLs embed the immutable build id +
          // content-addressed filename; safe to cache forever.
          res.setHeader('Cache-Control', IMMUTABLE_AUDIO_CACHE_CONTROL);
          const stream = fsCreateReadStream(cached);
          stream.on('error', (err) => {
            req.log.error({ err }, 'Stream error serving cached build preview audio');
            if (!res.headersSent) res.status(500).json({ error: 'Failed to stream audio' });
            else res.destroy();
          });
          stream.pipe(res);
          return;
        }

        // Pass 2: fall back to the project's current audio_files row.
        // Useful for earlier builds (no zip cache) and for
        // unconverted files that happen to share filenames.
        const fileResult = await pool.query(
          'SELECT * FROM audio_files WHERE project_id = $1 AND filename = $2',
          [id, filename],
        );
        if (fileResult.rows.length === 0) {
          res.status(404).json({ error: 'Audio file not found' });
          return;
        }
        const file = fileResult.rows[0];
        const key = audioKey(id, file.filename);

        // signed-URL 307 for the audio_files
        // fallback. Pass 1 above serves from the cached zip
        // extraction on local disk — no signed URL for that; we
        // stream those as before. Cache-Control: no-store on the
        // redirect since a signed URL is a per-request capability.
        if (useSignedUrlDownloads()) {
          try {
            const signedUrl = await getStorage().signedGetUrl(key);
            if (signedUrl) {
              res.setHeader('Cache-Control', 'no-store, private');
              res.redirect(307, signedUrl);
              return;
            }
          } catch (err) {
            req.log.warn(
              { err, buildId, key },
              'signedGetUrl threw for build preview audio — falling through to stream',
            );
          }
        }

        let stream: NodeJS.ReadableStream;
        try {
          stream = await getStorage().downloadStream(key);
        } catch (err) {
          req.log.error({ err }, 'Audio file not found in storage');
          res.status(404).json({ error: 'Audio file not found' });
          return;
        }
        res.setHeader('Content-Type', file.mime_type || 'audio/mpeg');
        res.setHeader('Content-Length', file.size_bytes);
        // Same content-addressed immutability as the cached-zip path
        // above.
        res.setHeader('Cache-Control', IMMUTABLE_AUDIO_CACHE_CONTROL);
        stream.on('error', (err) => {
          req.log.error({ err }, 'Stream error serving build preview audio');
          if (!res.headersSent) res.status(500).json({ error: 'Failed to stream audio' });
          else res.destroy();
        });
        stream.pipe(res);
      } catch (error) {
        req.log.error({ err: error }, 'Failed to serve build preview audio');
        res.status(500).json({ error: 'Failed to serve audio' });
      }
    },
  );

  /**
   * @openapi
   * /projects/{id}/builds/{buildId}/pin:
   *   post:
   *     summary: Set or toggle the pinned flag on a build.
   *     description: |
   *       Pinned builds are exempted from the automatic
   *       retention sweep (planned) — they stay indefinitely
   *       until explicitly unpinned or deleted. Only completed or
   *       failed builds can be pinned.
   *
   *       Body is optional: pass `{ "pinned": true }` or `{ "pinned":
   *       false }` for an idempotent set (safe on retry / double-click).
   *       Omit the body to toggle the current state.
   *     tags: [Builds]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: buildId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               pinned: { type: boolean }
   *     responses:
   *       200:
   *         description: Pin state after the update.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 build:
   *                   $ref: '#/components/schemas/Build'
   *       400: { description: Body pinned field is not a boolean. }
   *       404: { description: Build not found (or soft-deleted). }
   *       409: { description: Build is still in progress. }
   */
  router.post('/:id/builds/:buildId/pin', async (req: Request, res: Response) => {
    try {
      const { id, buildId } = req.params;

      // Explicit `pinned` in the body → idempotent set. Missing body
      // (or missing field) → toggle for back-compat with the plan's
      // "POST /pin = toggle" contract. A body with a non-boolean
      // `pinned` value is a client error — 400 rather than silently
      // treating it as toggle.
      const rawBody: unknown = req.body;
      const bodyPinned =
        rawBody && typeof rawBody === 'object' && 'pinned' in rawBody
          ? (rawBody as { pinned: unknown }).pinned
          : undefined;
      if (bodyPinned !== undefined && typeof bodyPinned !== 'boolean') {
        res.status(400).json({ error: 'Body pinned must be a boolean' });
        return;
      }

      // Only completed/failed builds are pinnable — in-progress builds
      // refuse with 409 so a user can't pin a build that might still
      // transition to failed and hold on to a failed artifact forever.
      const result =
        bodyPinned === undefined
          ? await pool.query(
              `UPDATE project_builds
                  SET pinned = NOT pinned
                WHERE id = $1
                  AND project_id = $2
                  AND deleted_at IS NULL
                  AND status IN ('completed', 'failed')
                RETURNING *`,
              [buildId, id],
            )
          : await pool.query(
              `UPDATE project_builds
                  SET pinned = $3
                WHERE id = $1
                  AND project_id = $2
                  AND deleted_at IS NULL
                  AND status IN ('completed', 'failed')
                RETURNING *`,
              [buildId, id, bodyPinned],
            );

      if (result.rows.length === 0) {
        const check = await pool.query(
          `SELECT status, deleted_at FROM project_builds WHERE id = $1 AND project_id = $2`,
          [buildId, id],
        );
        if (check.rows.length > 0 && check.rows[0].deleted_at === null) {
          res.status(409).json({ error: 'Cannot pin a build that is still in progress' });
        } else {
          res.status(404).json({ error: 'Build not found' });
        }
        return;
      }

      res.json({ build: formatBuild(result.rows[0]) });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to toggle build pin');
      res.status(500).json({ error: 'Failed to toggle build pin' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/builds/{buildId}/cancel:
   *   post:
   *     summary: Cooperatively cancel an in-progress build.
   *     description: |
   *       (phase 5). Sets `status = 'cancelled'` on a queued
   *       or processing build. Every intermediate + terminal UPDATE
   *       inside executeBuild is guarded by
   *       `status IN ('pending','processing')`, so a cancelled build
   *       stays cancelled even if the pipeline runs to completion.
   *
   *       If the pipeline finishes writing an artifact for a
   *       cancelled build, the completion UPDATE matches 0 rows and
   *       the storage object is deleted immediately (logged as
   *       `build.orphan.reap`) — the cancelled row never points at an
   *       artifact, so no consumer can download it.
   *
   *       Terminal-state rows (completed, failed, already cancelled)
   *       refuse with 409 — they can't transition back.
   *     tags: [Builds]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: buildId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Cancelled.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 build: { $ref: '#/components/schemas/Build' }
   *       404: { description: Build not found (or soft-deleted). }
   *       409: { description: Build is already in a terminal state. }
   */
  router.post('/:id/builds/:buildId/cancel', async (req: Request, res: Response) => {
    try {
      const { id, buildId } = req.params;

      // Only pending/processing rows can transition to cancelled.
      // Guarded on deleted_at so a soft-deleted row can't be
      // "un-deleted" via a cancel.
      const result = await pool.query(
        `UPDATE project_builds
            SET status = 'cancelled',
                completed_at = NOW(),
                message = COALESCE(message, 'Cancelled by user')
          WHERE id = $1
            AND project_id = $2
            AND deleted_at IS NULL
            AND status IN ('pending', 'processing')
          RETURNING *`,
        [buildId, id],
      );

      if (result.rows.length === 0) {
        const check = await pool.query(
          `SELECT status, deleted_at FROM project_builds WHERE id = $1 AND project_id = $2`,
          [buildId, id],
        );
        if (check.rows.length > 0 && check.rows[0].deleted_at === null) {
          res.status(409).json({
            error: `Cannot cancel a build in status '${check.rows[0].status}'`,
          });
        } else {
          res.status(404).json({ error: 'Build not found' });
        }
        return;
      }

      req.log.info({ event: 'build.cancelled', buildId, projectId: id }, 'Build cancelled by user');

      res.json({ build: formatBuild(result.rows[0]) });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to cancel build');
      res.status(500).json({ error: 'Failed to cancel build' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/builds/{buildId}:
   *   delete:
   *     summary: Soft-delete a completed or failed build.
   *     description: |
   *       sets `deleted_at = NOW()` instead of hard-deleting the
   *       row + artifact. The build is immediately hidden from the list,
   *       download, and preview endpoints. A reconciliation sweep at
   *       server startup hard-deletes rows past the 24h grace window
   *       (`SOFT_DELETE_GRACE_HOURS`).
   *
   *       In-progress builds (`pending`, `processing`) refuse with 409 —
   *       cancel via the executeBuild lifecycle instead.
   *     tags: [Builds]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: buildId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Deleted.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *                 deleted: { type: string, format: uuid }
   *       404: { description: Build not found. }
   *       409: { description: Build is still in progress. }
   */
  router.delete('/:id/builds/:buildId', async (req: Request, res: Response) => {
    try {
      const { id, buildId } = req.params;

      // soft-delete instead of hard-delete. The row stays in
      // the table with deleted_at = NOW() and is hidden from the list
      // + downloads. reconcileSoftDeletedBuilds hard-deletes the row
      // + artifact + preview cache after SOFT_DELETE_GRACE_HOURS. This
      // gives an accidental delete a 24h recovery window.
      //
      // We unpin as part of the soft-delete so the reconciliation
      // sweep's `AND pinned = FALSE` guard doesn't strand this row
      // forever if the user pinned it first.
      const result = await pool.query(
        `UPDATE project_builds
            SET deleted_at = NOW(), pinned = FALSE
          WHERE id = $1
            AND project_id = $2
            AND deleted_at IS NULL
            AND status IN ('completed', 'failed')
          RETURNING *`,
        [buildId, id],
      );

      if (result.rows.length === 0) {
        // Row exists but couldn't be soft-deleted — narrow to the
        // right 4xx. Include soft-deleted rows in this probe so an
        // already-deleted build reports 404 (not 409).
        const check = await pool.query(
          `SELECT status, deleted_at FROM project_builds WHERE id = $1 AND project_id = $2`,
          [buildId, id],
        );
        if (check.rows.length > 0 && check.rows[0].deleted_at === null) {
          res.status(409).json({ error: 'Cannot delete a build that is still in progress' });
        } else {
          res.status(404).json({ error: 'Build not found' });
        }
        return;
      }

      res.json({ success: true, deleted: buildId });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to delete build');
      res.status(500).json({ error: 'Failed to delete build' });
    }
  });
}
