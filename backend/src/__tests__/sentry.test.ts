import { jest } from '@jest/globals';

// We test the env-gated init guard. The actual Sentry SDK is mocked so we
// don't need a real DSN or network access.
const initSpy = jest.fn();
jest.unstable_mockModule('@sentry/node', () => ({
  init: initSpy,
}));

// Import after the mock so the module-under-test picks it up.
const { initSentry } = await import('../sentry.js');

describe('initSentry', () => {
  // Snapshot only the keys this test mutates so we don't replace
  // `process.env` wholesale (Node treats it as a special object — a
  // plain-object replacement loses its native getters and can leak
  // into other test files in the same Jest worker).
  const TOUCHED_KEYS = ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_RELEASE'] as const;
  const originalValues: Partial<Record<(typeof TOUCHED_KEYS)[number], string | undefined>> = {};

  beforeAll(() => {
    for (const k of TOUCHED_KEYS) originalValues[k] = process.env[k];
  });

  beforeEach(() => {
    initSpy.mockClear();
    for (const k of TOUCHED_KEYS) delete process.env[k];
  });

  afterAll(() => {
    for (const k of TOUCHED_KEYS) {
      if (originalValues[k] === undefined) delete process.env[k];
      else process.env[k] = originalValues[k];
    }
  });

  it('does nothing when SENTRY_DSN is unset', () => {
    initSentry();
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('initialises Sentry when SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.example/1';
    initSentry();
    expect(initSpy).toHaveBeenCalledTimes(1);
    const opts = initSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.dsn).toBe('https://abc@sentry.example/1');
    expect(opts.sendDefaultPii).toBe(false);
  });

  it('uses SENTRY_ENVIRONMENT when set, else falls back to NODE_ENV', () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.example/1';
    process.env.SENTRY_ENVIRONMENT = 'staging';
    initSentry();
    const opts = initSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.environment).toBe('staging');
  });

  it('passes SENTRY_RELEASE through', () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.example/1';
    process.env.SENTRY_RELEASE = 'wanderline@deadbeef';
    initSentry();
    const opts = initSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.release).toBe('wanderline@deadbeef');
  });

  it.each([
    ['unset', undefined, 0],
    ['empty string', '', 0],
    ['valid float', '0.25', 0.25],
    ['boundary 0', '0', 0],
    ['boundary 1', '1', 1],
    ['NaN string', 'not-a-number', 0],
    ['out of range high', '2', 0],
    ['out of range negative', '-0.5', 0],
  ])('parses SENTRY_TRACES_SAMPLE_RATE: %s', (_label, value, expected) => {
    process.env.SENTRY_DSN = 'https://abc@sentry.example/1';
    if (value !== undefined) process.env.SENTRY_TRACES_SAMPLE_RATE = value;
    initSentry();
    const opts = initSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.tracesSampleRate).toBe(expected);
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  });
});
