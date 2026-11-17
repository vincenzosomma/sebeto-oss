import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactUrl } from './logger.js';

describe('logger', () => {
  it('writes JSON and redacts tokens', () => {
    const lines: string[] = [];
    const destination = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const log = createLogger({ level: 'info', destination });
    log.info({ token: 'secret-1', config: { apiToken: 'secret-2' }, headers: { authorization: 'Bearer secret-3' } }, 'hello');
    const out = lines.join('');
    expect(out).not.toMatch(/secret-/);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: 'info', msg: 'hello', token: '[REDACTED]' });
  });

  it('redacts token query params from URLs', () => {
    expect(redactUrl('/api/v1/events?token=abc&x=1')).toBe('/api/v1/events?token=[REDACTED]&x=1');
    expect(redactUrl('/?a=1&token=abc')).toBe('/?a=1&token=[REDACTED]');
  });
});
