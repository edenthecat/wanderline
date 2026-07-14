// Sentry must initialise before any other module is loaded so its
// auto-instrumentation can patch http/express/pg. Keep this import first.
import './instrument.js';

import express, { Router } from 'express';
import { createServer } from 'http';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pinoHttp } from 'pino-http';
import { Pool } from 'pg';
import { Sentry } from './sentry.js';
import { parseInk } from './services/ink-parser.js';
import { parseInkJson } from './services/ink-json-parser.js';
import { randomUUID } from 'crypto';
import { initializeDatabase } from './db/init.js';
import { createProjectsRouter } from './routes/projects.js';
import { createAudioRouter } from './routes/audio.js';
import { createMetadataRouter } from './routes/metadata.js';
import { createCharactersRouter } from './routes/characters.js';
import { createCollaboratorsRouter } from './routes/projects-collaborators.js';
import { createAuthRouter } from './routes/auth.js';
import { createSetupRouter } from './routes/setup.js';
import { createUsersRouter } from './routes/users.js';
import {
  createInvitationsRouter,
  createPublicInvitationsRouter,
  cleanupExpiredInvitations,
} from './routes/invitations.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { UPLOAD_DIR } from './config.js';
import {
  apiLimiter,
  authLimiter,
  buildEnqueueLimiter,
  invitationCreateLimiter,
  invitationTokenLookupLimiter,
  invitationAcceptLimiter,
  publicPreviewHtmlLimiter,
  publicPreviewAudioLimiter,
  noopLimiter,
} from './middleware/rate-limit.js';
import {
  cleanupStaleBuilds,
  parseIntEnv,
  reconcileSoftDeletedBuilds,
} from './services/build-service.js';
import { attachCollabServer } from './services/collab-server.js';
import { getPlayerDist, mountPublicPreviewRoutes } from './routes/projects-preview.js';
import { logger } from './logger.js';
import { join } from 'path';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiSpec } from './openapi.js';

const app = express();
const port = process.env.PORT || 3001;

// Trust reverse proxy in production (needed for secure cookies behind TLS-terminating proxy)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Security headers — strict for JSON API, relaxed for preview/player/audio routes
const helmetStrict = helmet({
  // Allow cross-origin resource loading for audio files served to the frontend
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
const helmetRelaxed = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/_player') ||
    req.path.includes('/preview') ||
    req.path.includes('/audio')
  ) {
    return helmetRelaxed(req, res, next);
  }
  return helmetStrict(req, res, next);
});

// Middleware
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

// Request logging. pino-http attaches `req.log` (a child logger with a
// per-request id) and emits one structured line per response. Health
// checks and the static player-app bundle are excluded so noisy
// background polling doesn't drown out real traffic.
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: {
      // log-volume noise reduction. Health checks, player
      // static bundle, and the two audio hot paths (live preview
      // + per-build preview) are the highest-volume routes — every
      // audio file play generates one log line per user per node.
      // In production those hit Cloud Logging ingestion billing but
      // carry no triage signal (URLs are content-addressed, status
      // is 200 or 307). Ignoring them cuts logging volume
      // dramatically without losing anything actionable.
      ignore: (req) => {
        const url = req.url ?? '';
        if (url === '/health') return true;
        if (url.startsWith('/api/_player')) return true;
        // Audio paths — /api/projects/:id/preview/audio/:filename and
        // /api/projects/:id/builds/:buildId/preview/audio/:filename.
        if (/^\/api\/projects\/[^/]+\/(?:builds\/[^/]+\/)?preview\/audio\//.test(url)) return true;
        return false;
      },
    },
  }),
);

// Database connection
// On Cloud Run, secrets get injected as separate env vars (DB_PASSWORD) and the
// Cloud SQL instance attaches a Unix socket. Assemble the connection string
// from parts when those are present; otherwise use DATABASE_URL directly.
function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const parts = ['DB_USER', 'DB_PASSWORD', 'DB_NAME', 'INSTANCE_CONNECTION_NAME'] as const;
  const present = parts.filter((k) => process.env[k]);
  if (present.length === 0) {
    throw new Error(
      'No database configuration found. Set DATABASE_URL, or set all of: ' + parts.join(', '),
    );
  }
  if (present.length !== parts.length) {
    const missing = parts.filter((k) => !process.env[k]);
    throw new Error(
      `Partial Cloud SQL config detected (set: ${present.join(', ')}; ` +
        `missing: ${missing.join(', ')}). Set all four or use DATABASE_URL.`,
    );
  }
  const { DB_USER, DB_PASSWORD, DB_NAME, INSTANCE_CONNECTION_NAME } = process.env as Record<
    (typeof parts)[number],
    string
  >;
  return `postgresql://${DB_USER}:${encodeURIComponent(DB_PASSWORD)}@/${DB_NAME}?host=/cloudsql/${INSTANCE_CONNECTION_NAME}`;
}

const pool = new Pool({
  connectionString: getDatabaseUrl(),
  // cap connections per Cloud Run instance. Cloud Run
  // max-instances=3 × max=8 = 24 potential connections, under
  // db-f1-micro's 25-connection ceiling and comfortable for larger
  // tiers. pg's default (10) would allow 30 total → occasional
  // "sorry, too many clients already" errors during traffic bursts.
  // POOL_MAX env var lets ops tune per env without a code change.
  max: parseIntEnv('POOL_MAX', 8),
  // idle connections above 30s get recycled — keeps low-traffic
  // instances from tying up DB slots they don't need.
  idleTimeoutMillis: 30_000,
});

// Session middleware. Pulled out so the WebSocket upgrade handler
// (collab-server.ts) can re-use the same session resolver against
// the incoming request — without it, ws connections would have no
// way to identify the user behind the socket.
const PgSession = connectPgSimple(session);
const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: (() => {
    // Fail closed in every environment. The previous dev fallback string
    // is world-visible in the public source, so any exposed instance
    // running without SESSION_SECRET could have its session cookies
    // forged for arbitrary users. NODE_ENV=test still needs a value —
    // the test harness sets one in its bootstrap.
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      throw new Error(
        'SESSION_SECRET environment variable must be set. ' +
          'Generate one with: openssl rand -base64 32',
      );
    }
    return secret;
  })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
});
app.use(sessionMiddleware);

// Database schema is initialized before the server starts listening (see bottom of file)

// Auth middleware
const { requireAuth, requireAdmin, requireProjectAccess, requireOwnerOrAdmin, canAccessProject } =
  createAuthMiddleware(pool);

// Anyone who lands on the backend's /invite/:token (e.g. an admin
// pasted the magic-link URL before PUBLIC_BASE_URL was configured,
// so it pointed at the API host instead of the editor) gets bounced
// to the editor's matching route. Without this redirect, Express
// returns the default "Cannot GET /invite/..." 404 and the invitee
// has a broken link. PUBLIC_BASE_URL must be set in prod for this to
// resolve to the correct editor host.
app.get('/invite/:token', (req, res) => {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!base) {
    res.status(404).json({
      error: 'Invitation handled by the editor — PUBLIC_BASE_URL not configured on this backend.',
    });
    return;
  }
  // Pass the raw token through so the editor's InvitePage can claim it.
  // req.params.token is already decoded by Express; re-encode for safety.
  res.redirect(302, `${base}/invite/${encodeURIComponent(req.params.token)}`);
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'ok',
      timestamp: result.rows[0].now,
      service: 'wanderline-backend',
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Database connection failed',
    });
  }
});

// Rate limiting on /api/*. Applied before any /api routes are mounted.
// Disable in tests / by env: RATE_LIMIT_DISABLED=1 (only "1" or "true" disable).
const rateLimitDisabled = ['1', 'true'].includes(
  (process.env.RATE_LIMIT_DISABLED || '').toLowerCase(),
);
const apiLim = rateLimitDisabled ? noopLimiter : apiLimiter;
const authLim = rateLimitDisabled ? noopLimiter : authLimiter;
const inviteCreateLim = rateLimitDisabled ? noopLimiter : invitationCreateLimiter;
const inviteTokenLookupLim = rateLimitDisabled ? noopLimiter : invitationTokenLookupLimiter;
const inviteAcceptLim = rateLimitDisabled ? noopLimiter : invitationAcceptLimiter;
// build-enqueue limiter is passed through the projects
// router into mountBuildRoutes so POST /projects/:id/builds carries
// a tighter per-user cap than the shared apiLim (600 / IP / 15min).
const buildEnqueueLim = rateLimitDisabled ? noopLimiter : buildEnqueueLimiter;
app.use('/api', apiLim);

// API info
app.get('/api', (req, res) => {
  res.json({
    message: 'Wanderline API',
    version: '0.1.0',
    endpoints: {
      'GET /api/projects': 'List all projects',
      'POST /api/projects': 'Create a new project',
      'GET /api/projects/:id': 'Get a project',
      'PATCH /api/projects/:id': 'Update a project',
      'DELETE /api/projects/:id': 'Delete a project',
      'POST /api/projects/:id/ink': 'Upload Ink file to project',
      'GET /api/projects/:id/settings': 'Get project settings',
      'PATCH /api/projects/:id/settings': 'Update project settings',
      'GET /api/projects/:id/export': 'Export project as .wanderline archive',
      'GET /api/projects/:id/preview': 'Preview project in browser',
      'GET /api/projects/:id/preview/audio/:filename': 'Serve audio file for preview',
      'GET /api/projects/:id/builds': 'List all builds for project (max 5)',
      'POST /api/projects/:id/builds': 'Start a new build',
      'GET /api/projects/:id/builds/:buildId': 'Get build status/details',
      'DELETE /api/projects/:id/builds/:buildId': 'Delete a build',
      'GET /api/projects/:id/builds/:buildId/download': 'Download build artifact',
      'GET /api/projects/:id/audio': 'List audio files for project',
      'POST /api/projects/:id/audio': 'Upload audio file (multipart/form-data, field: audio)',
      'POST /api/projects/:id/audio/bulk':
        'Bulk upload audio with auto-matching (field: audio, max 50 files)',
      'DELETE /api/projects/:id/audio': 'Delete all audio files for project',
      'DELETE /api/projects/:id/audio/:audioId': 'Delete single audio file',
      'GET /api/projects/:id/audio/file/:audioId': 'Stream audio file',
      'GET /api/projects/:id/audio/assignments': 'Get audio assignments for all nodes',
      'POST /api/projects/:id/audio/assignments': 'Assign audio to node',
      'DELETE /api/projects/:id/audio/assignments/:nodeId/:audioType': 'Remove audio assignment',
      'GET /api/projects/:id/audio/coverage': 'Get audio coverage stats',
      'GET /api/projects/:id/metadata': 'Get all node metadata for project',
      'GET /api/projects/:id/metadata/:nodeId': 'Get metadata for specific node',
      'PUT /api/projects/:id/metadata/:nodeId':
        'Update node metadata (transcript, timing, auto-advance)',
      'DELETE /api/projects/:id/metadata/:nodeId': 'Delete node metadata',
      'POST /api/parse': 'Parse Ink file (standalone)',
      'DELETE /api/admin/audio/all': 'Delete all audio files across all projects (admin)',
      'GET /health': 'Health check',
    },
  });
});

// Serve player-app static assets (no auth required, immutable bundles)
// Caches middleware per dist path, recreates only if path changes
let _playerStaticDist: string | null = null;
let _playerStaticHandler: ReturnType<typeof express.static> | null = null;
app.use('/api/_player', (req, res, next) => {
  const dist = getPlayerDist();
  if (dist !== _playerStaticDist) {
    _playerStaticDist = dist;
    _playerStaticHandler = express.static(join(dist, 'assets'), { maxAge: '1y', immutable: true });
  }
  _playerStaticHandler!(req, res, next);
});

// Public auth routes (no auth required) — tighter rate limit to slow brute force
// Anonymous public-preview routes. Mounted OUTSIDE /api/ and BEFORE
// requireAuth so a listener with a shared link never touches the
// session-auth path. The token in the URL is the sole access
// control — see mountPublicPreviewRoutes for the lookup logic.
const publicPreviewRouter = Router();
// Per-route rate limits sized in middleware/rate-limit.ts. Reuse
// the same rateLimitDisabled flag the /api routes consult so
// Cypress + jest environments (`RATE_LIMIT_DISABLED=1`) don't
// have to reason about 429s.
mountPublicPreviewRoutes(publicPreviewRouter, pool, {
  htmlLimiter: rateLimitDisabled ? noopLimiter : publicPreviewHtmlLimiter,
  audioLimiter: rateLimitDisabled ? noopLimiter : publicPreviewAudioLimiter,
});
app.use('/public-preview', publicPreviewRouter);

app.use('/api/setup', authLim, createSetupRouter(pool));
app.use('/api/auth', authLim, createAuthRouter(pool));

// User management routes (admin only)
app.use('/api/users', requireAdmin, createUsersRouter(pool));

// — OpenAPI spec + Swagger UI explorer. Admin-only because the
// spec inadvertently doubles as an attack surface map; rendering it
// to authenticated admins keeps it useful for integrators without
// exposing every endpoint to the open internet.
const openApiSpec = buildOpenApiSpec();
app.get('/api/openapi.json', requireAdmin, (_req, res) => {
  res.json(openApiSpec);
});
app.use('/api/docs', requireAdmin, swaggerUi.serve, swaggerUi.setup(openApiSpec));

// Magic-link invitations:
//   - /api/invitations (admin only) — create / list / revoke
//   - /api/invitations/token/* (public) — token resolution + acceptance,
//     rate-limited with authLim because they touch credentials
// the per-route inviteTokenLookupLim + inviteAcceptLim are
// the *primary* rate limits here. authLim was previously also
// applied as a mount-level baseline, but authLimiter's 10 / 5min
// is tighter than the per-route limiters (10 / min, 5 / hour) at
// the 5-minute timescale, so applying it on top made the per-route
// limiters effectively unreachable. Drop authLim here; apiLim is
// still applied at /api/* (600 / 15min) as a sanity ceiling.
app.use(
  '/api/invitations/token',
  createPublicInvitationsRouter(pool, inviteTokenLookupLim, inviteAcceptLim),
);
app.use('/api/invitations', requireAdmin, createInvitationsRouter(pool, inviteCreateLim));

// Mount specific nested routes before the projects router so they match first
// and avoid running the projects router's /:id middleware redundantly
app.use('/api/projects/:id/audio', requireAuth, requireProjectAccess, createAudioRouter(pool));
app.use(
  '/api/projects/:id/metadata',
  requireAuth,
  requireProjectAccess,
  createMetadataRouter(pool),
);
app.use(
  '/api/projects/:id/characters',
  requireAuth,
  requireProjectAccess,
  createCharactersRouter(pool),
);
app.use(
  '/api/projects/:id/collaborators',
  requireAuth,
  requireProjectAccess,
  createCollaboratorsRouter(pool, requireOwnerOrAdmin),
);

// Projects routes (auth required, project access checked per-route)
app.use(
  '/api/projects',
  requireAuth,
  createProjectsRouter(pool, requireProjectAccess, requireOwnerOrAdmin, buildEnqueueLim),
);

// Admin: Delete all audio files across all projects
app.delete('/api/admin/audio/all', requireAdmin, async (req, res) => {
  try {
    // Get counts before deletion
    const countResult = await pool.query('SELECT COUNT(*) as count FROM audio_files');
    const totalFiles = parseInt(countResult.rows[0].count, 10);

    if (totalFiles === 0) {
      res.json({ success: true, deleted: 0, message: 'No audio files to delete' });
      return;
    }

    // Get all project IDs that have audio files
    const projectsResult = await pool.query('SELECT DISTINCT project_id FROM audio_files');
    const projectIds = projectsResult.rows.map((r) => r.project_id);

    // Delete all assignments
    await pool.query('DELETE FROM node_audio_assignments');

    // Delete all audio file records
    await pool.query('DELETE FROM audio_files');

    // Delete physical files for each project
    const { rm } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const { join } = await import('path');

    let dirsRemoved = 0;
    for (const projectId of projectIds) {
      const projectDir = join(UPLOAD_DIR, projectId);
      if (existsSync(projectDir)) {
        try {
          await rm(projectDir, { recursive: true, force: true });
          dirsRemoved++;
        } catch (err) {
          req.log.warn({ err, projectDir }, 'Failed to remove project upload directory');
        }
      }
    }

    // Update all affected projects' timestamps
    await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)', [
      projectIds,
    ]);

    res.json({
      success: true,
      deleted: totalFiles,
      projectsAffected: projectIds.length,
      directoriesRemoved: dirsRemoved,
      message: `Deleted ${totalFiles} audio files across ${projectIds.length} projects`,
    });
  } catch (error) {
    req.log.error({ err: error }, 'Failed to delete all audio files');
    res.status(500).json({ error: 'Failed to delete all audio files' });
  }
});

// Standalone Parse Ink file endpoint (for quick testing without a project)
app.post('/api/parse', requireAuth, (req, res) => {
  try {
    let source: string;
    let title: string | undefined;

    // Handle both JSON and plain text bodies
    if (typeof req.body === 'string') {
      source = req.body;
    } else if (req.body && typeof req.body.source === 'string') {
      source = req.body.source;
      title = req.body.title;
    } else {
      res.status(400).json({
        error: 'Invalid request body',
        message: 'Expected { source: string, title?: string } or plain text Ink content',
      });
      return;
    }

    if (!source.trim()) {
      res.status(400).json({
        error: 'Empty source',
        message: 'Ink source content cannot be empty',
      });
      return;
    }

    const storyId = randomUUID();
    const storyGraph = parseInk(source, storyId, title);

    res.json({
      success: true,
      story: storyGraph,
      summary: {
        nodeCount: Object.keys(storyGraph.nodes).length,
        knotCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'knot').length,
        stitchCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'stitch').length,
        errorCount: storyGraph.validation.errors.length,
        warningCount: storyGraph.validation.warnings.length,
      },
    });
  } catch (error) {
    req.log.error({ err: error }, 'Parse error');
    res.status(500).json({
      error: 'Parse failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Parse compiled Ink JSON file endpoint
app.post('/api/parse-json', requireAuth, (req, res) => {
  try {
    let jsonContent: string;
    let title: string | undefined;

    // Handle JSON body
    if (typeof req.body === 'string') {
      jsonContent = req.body;
    } else if (req.body && typeof req.body.source === 'string') {
      jsonContent = req.body.source;
      title = req.body.title;
    } else if (req.body && req.body.inkVersion) {
      // Direct JSON object passed
      jsonContent = JSON.stringify(req.body);
    } else {
      res.status(400).json({
        error: 'Invalid request body',
        message: 'Expected compiled Ink JSON content',
      });
      return;
    }

    const storyId = randomUUID();
    const storyGraph = parseInkJson(jsonContent, storyId, title);

    res.json({
      success: true,
      story: storyGraph,
      summary: {
        nodeCount: Object.keys(storyGraph.nodes).length,
        knotCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'knot').length,
        stitchCount: Object.values(storyGraph.nodes).filter((n) => n.type === 'stitch').length,
        errorCount: storyGraph.validation.errors.length,
        warningCount: storyGraph.validation.warnings.length,
      },
    });
  } catch (error) {
    req.log.error({ err: error }, 'Parse JSON error');
    res.status(500).json({
      error: 'Parse failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Sentry error handler — must be registered after all routes, before any
// other error-handling middleware. No-op when SENTRY_DSN isn't set.
Sentry.setupExpressErrorHandler(app);

// Initialize database schema before accepting requests
initializeDatabase(pool)
  .then(async () => {
    await cleanupStaleBuilds(pool);
    // hard-delete soft-deleted builds past their grace window.
    // Fire-and-forget — reconcileSoftDeletedBuilds catches every failure
    // internally and never rejects, so an outer .catch() would be
    // unreachable and just add noise on top of the service-level log.
    void reconcileSoftDeletedBuilds(pool);
    // Daily-ish sweep of long-expired invitations. Don't await the
    // first run so startup isn't delayed by a slow DB call.
    cleanupExpiredInvitations(pool)
      .then((n) => n > 0 && logger.info({ removed: n }, 'Expired invitations cleaned up'))
      .catch((err) => logger.error({ err }, 'Initial invitation cleanup failed'));
    setInterval(
      () => {
        cleanupExpiredInvitations(pool)
          .then((n) => n > 0 && logger.info({ removed: n }, 'Expired invitations cleaned up'))
          .catch((err) => logger.error({ err }, 'Invitation cleanup failed'));
      },
      24 * 60 * 60 * 1000,
    ).unref();
    // Use http.createServer instead of app.listen so the WebSocket
    // bridge can hook the upgrade event on the same port.
    const httpServer = createServer(app);
    attachCollabServer(httpServer, { pool, sessionMiddleware, canAccessProject });
    httpServer.listen(port, () => {
      logger.info({ port }, 'Wanderline backend listening (with collab WS)');
    });
  })
  .catch((err) => {
    logger.fatal({ err }, 'Database initialization failed');
    process.exit(1);
  });
