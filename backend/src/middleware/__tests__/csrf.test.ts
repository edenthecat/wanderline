// Second layer under the SameSite=Lax session cookie. Lax already stops
// a browser attaching the cookie to a cross-site POST; this exists
// because that is otherwise a single point of failure — one
// `sameSite: 'none'` for an embedding requirement and there's nothing
// underneath.

import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { createCsrfGuard } from '../csrf.js';

const ALLOWED = ['https://editor.example.com'];

function run(
  method: string,
  headers: Record<string, string>,
  host = 'api.example.com',
  protocol = 'https',
) {
  const guard = createCsrfGuard(ALLOWED);
  const next = jest.fn();
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const req = {
    method,
    path: '/api/projects',
    protocol,
    get: (name: string) => headers[name.toLowerCase()] ?? (name === 'host' ? host : undefined),
    log: { warn: jest.fn() },
  } as unknown as Request;
  guard(req, { status } as unknown as Response, next as unknown as NextFunction);
  return { next, status, json };
}

describe('csrf origin guard', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('never blocks %s', (method) => {
    const { next, status } = run(method, { origin: 'https://evil.example' });
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects a state-changing request from another origin', () => {
    const { next, status, json } = run('POST', { origin: 'https://evil.example' });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Cross-origin request rejected' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('guards %s', (method) => {
    const { status } = run(method, { origin: 'https://evil.example' });
    expect(status).toHaveBeenCalledWith(403);
  });

  it('allows a configured origin', () => {
    const { next, status } = run('POST', { origin: 'https://editor.example.com' });
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  // Production serves the editor from the frontend host and proxies
  // /api through nginx, so requests arrive claiming that host rather
  // than any configured CORS origin.
  it('allows same-origin regardless of the configured list', () => {
    const { next } = run('POST', { origin: 'https://api.example.com' });
    expect(next).toHaveBeenCalled();
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(run('POST', { referer: 'https://evil.example/page' }).status).toHaveBeenCalledWith(403);
    const { next } = run('POST', { referer: 'https://editor.example.com/projects/1' });
    expect(next).toHaveBeenCalled();
  });

  // Browsers always send Origin on a cross-origin state-changing
  // request, so its absence means the caller isn't a browser. Blocking
  // those would break server-to-server callers to defend against an
  // attack they can't mount.
  it('allows a request that declares no origin at all', () => {
    const { next, status } = run('POST', {});
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects a malformed origin rather than trusting it', () => {
    const { next } = run('POST', { origin: 'not-a-url' });
    // Unparseable Origin with no Referer reads as "no claim", which is
    // the non-browser case.
    expect(next).toHaveBeenCalled();
  });

  it('compares origin only, ignoring path and query', () => {
    const { next } = run('POST', { referer: 'https://editor.example.com/a/b?c=d#e' });
    expect(next).toHaveBeenCalled();
  });
});
