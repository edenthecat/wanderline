import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';

/**
 * Rate limiting for the public API. Two tiers:
 *
 * - apiLimiter: applied to all /api/* routes. Generous so normal use (loading
 *   a project, streaming audio) isn't disrupted, but stops obvious abuse.
 *
 * - authLimiter: applied to login + admin-setup. Tight so brute-force attacks
 *   are slow even from a single IP.
 *
 * Both are in-memory per-instance. With Cloud Run's max-instances of 3, that
 * means the effective ceiling is 3x these numbers, which is acceptable for v1.
 * For tighter accuracy we'd back this with Redis (Memorystore), but that's
 * overkill for current traffic.
 *
 * Disable in tests by setting RATE_LIMIT_DISABLED=1.
 */

const baseOptions: Partial<Options> = {
  // draft-8 emits a single combined `RateLimit` header; the legacy
  // `X-RateLimit-*` headers are off.
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // 429 response shape matches the rest of the API. retryAfter reports the
  // *remaining* seconds in the current window (not the full window length),
  // so clients can back off accurately.
  handler: (req, res, _next, options) => {
    const reqWithLimit = req as typeof req & { rateLimit?: { resetTime?: Date } };
    const resetMs = reqWithLimit.rateLimit?.resetTime?.getTime();
    const remainingSec = resetMs
      ? Math.max(0, Math.ceil((resetMs - Date.now()) / 1000))
      : Math.ceil(options.windowMs / 1000);
    res.status(options.statusCode).json({
      error: 'Too many requests, please slow down.',
      retryAfter: remainingSec,
    });
  },
};

/**
 * Anonymous public-preview HTML endpoint. Only one HTML fetch
 * per listener session, so 60 / IP / minute is far more than any
 * legitimate use ever needs; the ceiling exists so a leaked
 * token can't be used to hammer the render path (which reissues
 * SRI, rebuilds CSP nonces, and re-queries the full story graph
 * every time).
 */
export const publicPreviewHtmlLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 60,
});

/**
 * Anonymous public-preview audio endpoint. Sized to survive an
 * aggressive story preload behind a shared NAT: a 50-audio story
 * with a handful of concurrent listeners can easily burst to
 * 10 requests / second in the first few seconds. 900 / IP / minute
 * (~15 req/sec sustained) sits well above that headroom while
 * still capping runaway scraping of a leaked token before the
 * author notices and disables.
 */
export const publicPreviewAudioLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 900,
});

/** Generous limit on all /api/* traffic. */
export const apiLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 600, // 600 requests per IP per window
});

/** Tight limit for credential endpoints. */
export const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 10, // 10 login/setup attempts per IP per window
  // Don't count successful logins; only failed attempts toward the limit
  skipSuccessfulRequests: true,
});

/**
 * Tight limit for admin-side invitation creation. Capped so a
 * compromised admin session can't bulk-spam invites or exhaust the
 * 32-byte token entropy budget. Same IP-keying as the other limiters
 * (per-instance, max 3× under Cloud Run's max instances).
 */
export const invitationCreateLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 20,
});

/**
 * token-resolution + token-acceptance limiters. The public
 * GET /invitations/token/:token endpoint resolves whether a token is
 * valid before the invitee creates an account, so it's the surface
 * a brute-forcer would hammer to guess tokens. Set to 10 / minute,
 * which matches the ticket AC: enough headroom for a legitimate
 * invitee to refresh / retry, low enough that a scanner can't make
 * sustained progress against the 32-byte token space. Index against
 * a per-minute window rather than authLimiter's 5-min one so the
 * bucket resets quickly for honest users.
 */
export const invitationTokenLookupLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000, // 1 minute
  limit: 10,
});

/**
 * POST /invitations/token/:token/accept is where account
 * creation actually happens. 5 / IP / hour matches the AC and is
 * still room for a few legitimate retries.
 */
export const invitationAcceptLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
});

/**
 * (Phase 5): tight limit on POST /projects/:id/builds. Building
 * is expensive — audio transcode + archive + storage upload — and a
 * runaway client (or an author double-clicking through a slow response)
 * can queue enough work to exhaust worker capacity for every other
 * project on the instance. 10 requests / 15-minute window strikes a
 * balance: legitimate retries after a failure get through, but a
 * misbehaving client hits 429 quickly.
 *
 * Keyed by session userId (falls back to IP for unauthenticated
 * requests, which shouldn't reach this route thanks to requireAuth
 * upstream — the IP fallback exists as a defence-in-depth). Per-user
 * keying is important: shared-office IPs shouldn't ratchet each other
 * out of building.
 */
export const buildEnqueueLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  // The IP-fallback branch runs `ipKeyGenerator` on `req.ip` so
  // multiple clients on the same IPv6 /64 subnet get grouped
  // together, matching how express-rate-limit's default key
  // generator handles v6. Without this, IPv6 users can trivially
  // bypass the limit by cycling their address inside their /64
  // (which most residential ISPs hand out), and express-rate-limit
  // v8 logs a startup ValidationError telling us so.
  keyGenerator: (req) => {
    const userId = (req as { session?: { userId?: string } }).session?.userId;
    if (userId) return `user:${userId}`;
    return `ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
});

/** No-op middleware for tests. */
export const noopLimiter = (_req: unknown, _res: unknown, next: () => void) => next();
