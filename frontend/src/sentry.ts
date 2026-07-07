import * as Sentry from '@sentry/react';

/**
 * True when Sentry has a DSN baked in at build time. Use this to decide
 * whether to mount Sentry-aware components (e.g. the ErrorBoundary) — if
 * Sentry isn't initialised, mounting its boundary still catches render
 * errors but suppresses Vite's dev error overlay, which we'd rather
 * keep in local dev.
 */
export const isSentryEnabled = Boolean(import.meta.env.VITE_SENTRY_DSN);

function parseSampleRate(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0 || n > 1) return 0;
  return n;
}

/**
 * Initialise Sentry for the editor frontend. No-op unless VITE_SENTRY_DSN
 * is set at build time. Vite inlines `import.meta.env.VITE_*` values, so
 * the DSN ends up baked into the bundle — that's fine; Sentry DSNs are
 * not secret, they're project identifiers.
 */
export function initSentry(): void {
  if (!isSentryEnabled) return;

  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    tracesSampleRate: parseSampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE),
    sendDefaultPii: false,
  });
}

export { Sentry };
