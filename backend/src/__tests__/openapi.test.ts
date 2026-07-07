import { buildOpenApiSpec } from '../openapi.js';

// smoke test the generated OpenAPI spec. A bad JSDoc annotation
// in any route file would silently produce an incomplete spec; this
// suite catches the most common breakage — missing tags, missing
// schema references, or missing key endpoints from the trunk.

interface Spec {
  openapi: string;
  info: { title: string; version: string };
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  paths: Record<string, Record<string, { tags?: string[] }>>;
}

describe('OpenAPI spec', () => {
  const spec = buildOpenApiSpec() as Spec;

  it('compiles into a valid 3.0.3 document', () => {
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('Wanderline API');
    expect(spec.info.version).toBeTruthy();
  });

  it('declares the shared security scheme + reusable schemas', () => {
    expect(spec.components.securitySchemes).toHaveProperty('sessionCookie');
    for (const required of [
      'AuthUser',
      'User',
      'Project',
      'Build',
      'PendingInvitation',
      'ProjectValidationReport',
      'Error',
    ]) {
      expect(spec.components.schemas).toHaveProperty(required);
    }
  });

  it('picks up the annotated routes', () => {
    // A representative selection from each annotated file. New routes
    // that get JSDoc'd should show up here automatically; if you add
    // one and the test still passes, double-check the path string in
    // the @openapi block.
    const required = [
      // Auth + setup
      '/auth/login',
      '/auth/logout',
      '/auth/me',
      '/setup',
      '/setup/status',
      // Users + invitations
      '/users',
      '/users/{userId}',
      '/invitations',
      '/invitations/{id}',
      '/invitations/token/{token}',
      '/invitations/token/{token}/accept',
      // Projects CRUD + nested
      '/projects',
      '/projects/{id}',
      '/projects/{id}/validate',
      '/projects/{id}/settings',
      '/projects/{id}/ink',
      '/projects/{id}/ink-json',
      // Builds
      '/projects/{id}/builds',
      '/projects/{id}/builds/{buildId}',
      '/projects/{id}/builds/{buildId}/download',
      '/projects/{id}/builds/{buildId}/preview',
      // Audio
      '/projects/{id}/audio',
      '/projects/{id}/audio/{audioId}',
      '/projects/{id}/audio/coverage',
      '/projects/{id}/audio/file/{audioId}',
      '/projects/{id}/audio/assignments',
      '/projects/{id}/audio/assignments/{nodeId}/{audioType}',
      // Metadata
      '/projects/{id}/metadata',
      '/projects/{id}/metadata/{nodeId}',
      // Characters
      '/projects/{id}/characters',
      '/projects/{id}/characters/{characterId}',
      // Collaborators
      '/projects/{id}/collaborators',
      '/projects/{id}/collaborators/{userId}',
      // Export + preview
      '/projects/{id}/export',
      '/projects/{id}/export-ink',
      '/projects/{id}/export-json',
      '/projects/{id}/preview',
    ];
    for (const path of required) {
      expect(spec.paths).toHaveProperty(path);
    }
  });

  it('tags the public endpoints with security: []', () => {
    // Endpoints reachable without a session cookie. swagger-jsdoc
    // lifts the per-op `security: []` override into the operation.
    const expectedPublic: Array<[string, string]> = [
      ['/auth/login', 'post'],
      ['/setup', 'post'],
      ['/setup/status', 'get'],
      ['/invitations/token/{token}', 'get'],
      ['/invitations/token/{token}/accept', 'post'],
    ];
    for (const [path, method] of expectedPublic) {
      const op = spec.paths[path]?.[method] as { security?: unknown[] } | undefined;
      expect(op?.security).toEqual([]);
    }
  });
});
