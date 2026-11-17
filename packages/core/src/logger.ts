/**
 * Structured logging (pino). Logs go to stderr so stdout stays reserved for the single
 * `SEBETO_READY {...}` line the shells parse. Tokens and auth headers are always redacted.
 */
import { pino, destination, stdTimeFunctions, type Logger as PinoLogger, type DestinationStream } from 'pino';
import type { Logger } from './contracts.js';

export const REDACT_PATHS = [
  'token',
  'apiToken',
  'authorization',
  '*.token',
  '*.apiToken',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'config.apiToken',
  'scope.token',
];

export interface LoggerOptions {
  level?: string;
  /** Defaults to stderr. Tests can pass a stream to capture output. */
  destination?: DestinationStream;
}

export type SebetoLogger = Logger & { pino: PinoLogger };

/** Remove `token=` query values from a URL before logging it. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|access_token)=)[^&#]*/gi, '$1[REDACTED]');
}

export function createLogger(opts: LoggerOptions = {}): SebetoLogger {
  const level = opts.level ?? process.env.SEBETO_LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
  const p = pino(
    {
      name: 'sebeto-core',
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    opts.destination ?? destination({ fd: 2, sync: true }),
  );
  const wrap = (fn: 'info' | 'warn' | 'error' | 'debug') => (obj: object | string, msg?: string) => {
    if (typeof obj === 'string') p[fn](obj);
    else p[fn](obj, msg);
  };
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug'), pino: p };
}
