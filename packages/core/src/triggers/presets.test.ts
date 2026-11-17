import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRESET_SAMPLES, getPath, parseWithPreset } from './presets.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const fx = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));

describe('webhook presets', () => {
  it('Alertmanager: one event per group, dedupe on groupKey, firing/resolved', () => {
    const firing = parseWithPreset('alertmanager', fx('alertmanager-firing'));
    expect(firing).toMatchObject({
      title: 'InstanceDown (2 alerts)', summary: 'Instance is down', severity: 'critical',
      host: 'srv-web01:9100, srv-web02:9100', status: 'firing',
    });
    expect(firing.dedupeKey).toBe('{}/{severity="critical"}:{alertname="InstanceDown"}');
    const resolved = parseWithPreset('alertmanager', fx('alertmanager-resolved'));
    expect(resolved.status).toBe('resolved');
    expect(resolved.dedupeKey).toBe(firing.dedupeKey);
  });

  it('Alertmanager without groupKey falls back to the first fingerprint', () => {
    const p = fx('alertmanager-firing') as Record<string, unknown>;
    delete p.groupKey;
    expect(parseWithPreset('alertmanager', p).dedupeKey).toBe('5b1a6a2c8f9e0d11');
  });

  it('Grafana: readable title, message, state, fingerprint/groupKey', () => {
    const f = parseWithPreset('grafana', fx('grafana-firing'));
    expect(f).toMatchObject({ title: 'High CPU Servers (srv-app03 warning)', severity: 'warning', host: 'srv-app03', status: 'firing' });
    expect(f.summary).toContain('Value: B=93.2');
    const r = parseWithPreset('grafana', fx('grafana-resolved'));
    expect(r.status).toBe('resolved');
    expect(r.dedupeKey).toBe(f.dedupeKey);
  });

  it('Uptime Kuma: heartbeat 0 = down (firing), 1 = up (resolved), dedupe on monitor id', () => {
    const down = parseWithPreset('uptime-kuma', fx('uptime-kuma-down'));
    expect(down).toMatchObject({ title: 'Intranet portal is down', summary: 'timeout of 48000ms exceeded', status: 'firing', dedupeKey: '7', host: 'https://intranet.corp.local' });
    const up = parseWithPreset('uptime-kuma', fx('uptime-kuma-up'));
    expect(up).toMatchObject({ title: 'Intranet portal is up', status: 'resolved', dedupeKey: '7' });
  });

  it('Zabbix: subject/message/severity/host/eventid, recovery flag', () => {
    const p = parseWithPreset('zabbix', fx('zabbix-problem'));
    expect(p).toMatchObject({ title: 'Free disk space is less than 5% on volume C:', severity: 'High', host: 'SRV-FS01', status: 'firing', dedupeKey: '884213' });
    const r = parseWithPreset('zabbix', fx('zabbix-recovery'));
    expect(r).toMatchObject({ status: 'resolved', dedupeKey: '884213', title: 'Free disk space is less than 5% on volume C:' });
  });

  it('generic: common field names, id as dedupe key', () => {
    expect(parseWithPreset('generic', fx('generic'))).toMatchObject({
      title: 'Backup failed', summary: 'Nightly backup of SRV-SQL01 failed with code 2', severity: 'major', host: 'srv-sql01', status: 'firing', dedupeKey: 'bk-2026-11-12',
    });
    expect(parseWithPreset('generic', { message: 'only a message', status: 'resolved' })).toMatchObject({ title: 'only a message', summary: '', status: 'resolved' });
    expect(parseWithPreset('generic', 'not an object')).toMatchObject({ title: 'Webhook alert', status: 'firing' });
    expect(parseWithPreset('generic', null).title).toBe('Webhook alert');
  });

  it('dedupeField overrides the preset key (dotted path, arrays by index)', () => {
    expect(parseWithPreset('alertmanager', fx('alertmanager-firing'), 'alerts.1.fingerprint').dedupeKey).toBe('7c2b8d3e9fa01e22');
    expect(parseWithPreset('generic', fx('generic'), 'host').dedupeKey).toBe('srv-sql01');
    // Missing path: keep the preset's key.
    expect(parseWithPreset('generic', fx('generic'), 'nope.nothing').dedupeKey).toBe('bk-2026-11-12');
  });

  it('getPath never walks prototypes', () => {
    expect(getPath({}, 'constructor.name')).toBeUndefined();
    expect(getPath({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1);
    expect(getPath({ a: 1 }, 'a..b')).toBeUndefined();
  });

  it('every preset parses its own sample', () => {
    for (const [preset, sample] of Object.entries(PRESET_SAMPLES)) {
      const ev = parseWithPreset(preset as keyof typeof PRESET_SAMPLES, sample);
      expect(ev.title, preset).not.toBe('');
      expect(ev.status, preset).toBe('firing');
      expect(ev.dedupeKey, preset).not.toBe('');
    }
  });
});
