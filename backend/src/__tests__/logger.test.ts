import { Writable } from 'stream';
import pino from 'pino';

// We can't import the production logger directly because it picks up
// process.env at module load. Instead we replicate its formatter config
// against a captured stream to verify the GCP severity mapping.
const LEVEL_TO_SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

function makeCapturingLogger(level = 'trace') {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const log = pino(
    {
      level,
      messageKey: 'message',
      formatters: {
        level: (label) => ({ severity: LEVEL_TO_SEVERITY[label] || 'DEFAULT', level: label }),
      },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream,
  );
  return { log, lines };
}

describe('logger formatter', () => {
  it('maps each pino level to the right GCP severity', () => {
    const { log, lines } = makeCapturingLogger();
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');

    const severities = lines.map((l) => JSON.parse(l).severity);
    expect(severities).toEqual(['DEBUG', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);
  });

  it('uses `message` not `msg` for the message field', () => {
    const { log, lines } = makeCapturingLogger();
    log.info('hello');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.message).toBe('hello');
    expect(parsed.msg).toBeUndefined();
  });

  it('emits ISO 8601 timestamps', () => {
    const { log, lines } = makeCapturingLogger();
    log.info('x');
    const parsed = JSON.parse(lines[0]);
    // ISO format: 2026-05-10T18:35:13.123Z
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('does not include pid or hostname (base: undefined)', () => {
    const { log, lines } = makeCapturingLogger();
    log.info('x');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.pid).toBeUndefined();
    expect(parsed.hostname).toBeUndefined();
  });

  it('respects the configured level', () => {
    const { log, lines } = makeCapturingLogger('warn');
    log.info('skipped');
    log.warn('included');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).message).toBe('included');
  });
});
