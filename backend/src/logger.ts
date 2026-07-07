import pino, { type LoggerOptions } from 'pino';

// Map pino's numeric levels to the severity strings GCP Cloud Logging
// (and most aggregators) expect. Without this, JSON log lines on Cloud
// Run come through as INFO regardless of severity.
const LEVEL_TO_SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  // GCP looks for `message` (not `msg`) and `severity` (not `level`).
  messageKey: 'message',
  formatters: {
    level: (label) => ({ severity: LEVEL_TO_SEVERITY[label] || 'DEFAULT', level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Don't log Node's pid/hostname in prod — Cloud Run's structured logs
  // already capture instance metadata, and they're noise locally.
  base: undefined,
};

// Pretty-print in dev so the terminal stays readable. Prod always emits
// JSON so Cloud Logging can parse it. Tests skip the transport entirely
// so we don't spawn pino-pretty's worker thread (which can keep Jest
// open-handles alive) — combined with level: 'silent' above, nothing
// writes anyway.
const transport: LoggerOptions['transport'] =
  isProd || isTest
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      };

export const logger = pino({ ...baseOptions, transport });

export type Logger = typeof logger;
