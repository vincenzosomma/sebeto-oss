import { describe, expect, it } from 'vitest';
import { cronToSchedule, curlExample, hookUrl, originBadge, powershellExample, scheduleToCron } from './triggers';

describe('trigger helpers', () => {
  it('friendly schedules round-trip through cron', () => {
    expect(scheduleToCron({ mode: 'daily', time: '08:30', weekday: 1 })).toBe('30 8 * * *');
    expect(scheduleToCron({ mode: 'weekly', time: '07:05', weekday: 1 })).toBe('5 7 * * 1');
    expect(scheduleToCron({ mode: 'weekdays', time: '18:00', weekday: 1 })).toBe('0 18 * * 1-5');
    expect(scheduleToCron({ mode: 'monthly', time: '09:00', weekday: 1 })).toBe('0 9 1 * *');
    expect(scheduleToCron({ mode: 'advanced', time: '', weekday: 0 }, ' */15 * * * * ')).toBe('*/15 * * * *');
    expect(cronToSchedule('5 7 * * 1')).toEqual({ mode: 'weekly', time: '07:05', weekday: 1 });
    expect(cronToSchedule('0 9 1 * *')).toMatchObject({ mode: 'monthly', time: '09:00' });
    expect(cronToSchedule('0 18 * * 1-5')).toMatchObject({ mode: 'weekdays' });
    expect(cronToSchedule('*/15 * * * *').mode).toBe('advanced');
  });

  it('builds call examples and URLs', () => {
    const url = hookUrl('http://127.0.0.1:7600/', '/api/v1/hooks/abc');
    expect(url).toBe('http://127.0.0.1:7600/api/v1/hooks/abc');
    expect(curlExample(url, 'S3CRET')).toContain('-H "Authorization: Bearer S3CRET"');
    expect(powershellExample(url, 'S3CRET')).toContain('Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7600/api/v1/hooks/abc"');
  });

  it('origin badges', () => {
    expect(originBadge(null)).toBeNull();
    expect(originBadge({ kind: 'manual', untrusted: false })).toBeNull();
    expect(originBadge({ kind: 'trigger', triggerKind: 'webhook', source: 'Alertmanager', untrusted: true })).toEqual({ icon: '⚡', label: 'Alertmanager', untrusted: true });
    expect(originBadge({ kind: 'trigger', triggerKind: 'mail', source: 'mail from x.org', untrusted: true })?.icon).toBe('✉');
    expect(originBadge({ kind: 'trigger', triggerKind: 'schedule', untrusted: false })).toEqual({ icon: '⏰', label: 'schedule', untrusted: false });
  });
});
