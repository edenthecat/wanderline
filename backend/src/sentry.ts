import * as Sentry from '@sentry/node';
import { logger } from './logger.js';

/**
 * Parse a Sentry sample-rate env var into a number in [0, 1]. Anything
 * unparseable, NaN, or out of range falls back to 0 so a typo doesn't
 * accidentally crank tracing to 100% (or break Sentry init outright).
 */
function parseSampleRate(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0 || n > 1) return 0;
  return n;
}

/**
 * Initialize Sentry. Only takes effect if SENTRY_DSN is set; otherwise
 * Sentry calls become no-ops, which is what we want in dev/test/CI.
 *
 * Call this BEFORE constructing the Express app — Sentry's auto-instrumentation
 * patches `http`, `express`, `pg`, etc. at require time, and the patches only
 * stick if Sentry initialised first.
 *
 * Wire the request + error handlers separately via `setupExpressErrorHandler`
 * after all routes are mounted (see index.ts).
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('Sentry disabled (SENTRY_DSN not set)');
    return;
  }

  const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';

  Sentry.init({
    dsn,
    environment,
    release: process.env.SENTRY_RELEASE,
    // Tracing off by default — the volume on a small backend isn't worth
    // paying for APM yet. Turn on by setting SENTRY_TRACES_SAMPLE_RATE
    // (0–1); a misconfigured / non-numeric value falls back to 0.
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    // Don't send request bodies / cookies / headers. The default `sendDefaultPii`
    // is false; we keep it explicit so anyone reading this knows we *chose* not
    // to ship PII to Sentry.
    sendDefaultPii: false,
  });

  logger.info({ environment }, 'Sentry initialised');
}

export { Sentry };
