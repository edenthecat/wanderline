import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Origin verification for state-changing requests.
//
// The session cookie is already SameSite=Lax, which stops a browser
// attaching it to a cross-site POST — the classic CSRF vector. This is
// the second layer, and it exists because Lax is a single point of
// failure: one `sameSite: 'none'` for an embedding requirement, or one
// browser that treats an edge case differently, and there is nothing
// underneath.
//
// Deliberately NOT a token scheme. Tokens would mean an issuing
// endpoint, storage, rotation, and a change to every mutating call in
// the client — a large surface to add for a threat the cookie policy
// already blocks. An origin check is the OWASP-recommended companion
// to SameSite and needs no client changes at all.
//
// The one judgment call: a request with NO Origin and NO Referer is
// allowed through. Browsers always send Origin on cross-origin
// state-changing requests, so their absence means the caller is not a
// browser — server-to-server, curl, a health check. Rejecting those
// would break legitimate callers to defend against an attack they
// cannot mount, since a page-driven forgery always carries an Origin.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Origin of a URL, or null if it isn't parseable. */
function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function createCsrfGuard(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map((o) => originOf(o) ?? o));

  return function csrfGuard(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    // Prefer Origin; fall back to Referer, which older clients send
    // when Origin is omitted.
    const claimed = originOf(req.get('origin')) ?? originOf(req.get('referer'));
    if (!claimed) {
      next();
      return;
    }

    // Same-origin is always fine: in production the browser talks to
    // the frontend host and nginx proxies /api through, so requests
    // arrive carrying that host rather than a configured CORS origin.
    const self = `${req.protocol}://${req.get('host')}`;
    if (claimed === self || allowed.has(claimed)) {
      next();
      return;
    }

    req.log?.warn(
      { claimed, method: req.method, path: req.path },
      'Rejected cross-origin state-changing request',
    );
    res.status(403).json({ error: 'Cross-origin request rejected' });
  };
}
