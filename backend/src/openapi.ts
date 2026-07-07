import swaggerJSDoc from 'swagger-jsdoc';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// OpenAPI/Swagger documentation.
//
// We annotate Express routes with @openapi JSDoc comments and let
// swagger-jsdoc compile the spec. swagger-ui-express then mounts a
// human-readable explorer at /api/docs (admin-only).
//
// New endpoints are added by writing JSDoc above the route handler —
// see backend/src/routes/auth.ts for examples. The components.schemas
// block below holds the shared shapes (User, Project, Invitation, ...)
// so individual handlers can reference them by $ref.

export function buildOpenApiSpec(): object {
  // Resolve route files relative to whichever dist/src layout is live —
  // matches initializeDatabase's strategy in db/init.ts.
  const routesGlobSrc = join(__dirname, 'routes', '*.{ts,js}');
  const routesGlobDist = join(__dirname, '..', 'src', 'routes', '*.{ts,js}');

  return swaggerJSDoc({
    definition: {
      openapi: '3.0.3',
      info: {
        title: 'Wanderline API',
        version: '0.1.0',
        description:
          'HTTP API for the Wanderline editor. Auth uses session cookies issued by `/api/auth/login`. Most endpoints require a logged-in user; admin routes additionally require `users.role = "admin"`.',
      },
      servers: [{ url: '/api', description: 'Active server (same origin)' }],
      components: {
        // Cookie-based session auth. Editor / player clients include
        // the `connect.sid` cookie on every request automatically.
        securitySchemes: {
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: 'connect.sid',
          },
        },
        schemas: {
          Error: {
            type: 'object',
            properties: { error: { type: 'string' } },
            required: ['error'],
          },
          User: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string', format: 'email' },
              displayName: { type: 'string' },
              role: { type: 'string', enum: ['admin', 'editor'] },
              isActive: { type: 'boolean' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'email', 'displayName', 'role'],
          },
          AuthUser: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string', format: 'email' },
              displayName: { type: 'string' },
              role: { type: 'string', enum: ['admin', 'editor'] },
            },
            required: ['id', 'email', 'displayName', 'role'],
          },
          Project: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              description: { type: 'string', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'name'],
          },
          Build: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              buildNumber: { type: 'integer' },
              status: {
                type: 'string',
                enum: ['pending', 'processing', 'completed', 'failed'],
              },
              progress: { type: 'integer', minimum: 0, maximum: 100 },
              message: { type: 'string', nullable: true },
              error: { type: 'string', nullable: true },
              label: { type: 'string', nullable: true },
              totalSizeBytes: { type: 'integer', nullable: true },
              audioSizeBytes: { type: 'integer', nullable: true },
              codeSizeBytes: { type: 'integer', nullable: true },
              audioFileCount: { type: 'integer', nullable: true },
              nodeCount: { type: 'integer', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              completedAt: { type: 'string', format: 'date-time', nullable: true },
              // pinning + soft-delete groundwork.
              pinned: { type: 'boolean' },
              // which player-app bundle this build shipped
              // against. Both null on rows created earlier
              // OR when bundle-info.json couldn't be read at build time
              // (best-effort — recording metadata never blocks a build).
              playerBundleVersion: { type: 'string', nullable: true },
              playerBundleSriHash: { type: 'string', nullable: true },
              // attempt-count for retry visibility, idempotency
              // key echoed back so callers can confirm a same-key retry
              // deduped to the row they expected.
              attemptCount: { type: 'integer' },
              idempotencyKey: { type: 'string', nullable: true },
            },
            required: [
              'id',
              'buildNumber',
              'status',
              'progress',
              'pinned',
              'playerBundleVersion',
              'playerBundleSriHash',
              'attemptCount',
              'idempotencyKey',
            ],
          },
          PendingInvitation: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string', format: 'email' },
              role: { type: 'string', enum: ['admin', 'editor'] },
              invitedBy: { type: 'string', format: 'uuid', nullable: true },
              expiresAt: { type: 'string', format: 'date-time' },
              createdAt: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'email', 'role', 'expiresAt', 'createdAt'],
          },
          ProjectValidationReport: {
            type: 'object',
            properties: {
              projectId: { type: 'string', format: 'uuid' },
              hasStory: { type: 'boolean' },
              summary: {
                type: 'object',
                properties: {
                  nodeCount: { type: 'integer' },
                  audioFileCount: { type: 'integer' },
                  audioAssignmentCount: { type: 'integer' },
                  errorCount: { type: 'integer' },
                  warningCount: { type: 'integer' },
                  missingAudioCount: { type: 'integer' },
                  orphanedAudioCount: { type: 'integer' },
                },
              },
              storyIssues: {
                type: 'object',
                properties: {
                  errors: { type: 'array', items: { type: 'object' } },
                  warnings: { type: 'array', items: { type: 'object' } },
                },
              },
              audioCoverage: {
                type: 'object',
                properties: {
                  missingAssignments: { type: 'array', items: { type: 'object' } },
                  orphanedFiles: { type: 'array', items: { type: 'object' } },
                  missingIndicatorAudio: { type: 'array', items: { type: 'object' } },
                },
              },
            },
            required: ['projectId', 'hasStory'],
          },
        },
      },
      // Endpoints assume session auth unless they override security.
      security: [{ sessionCookie: [] }],
    },
    // swagger-jsdoc accepts globs and scans .ts files for JSDoc tags.
    // Listing both src and dist paths keeps the spec working in dev
    // (tsx-loaded TS) and prod (compiled JS).
    apis: [routesGlobSrc, routesGlobDist],
  });
}
