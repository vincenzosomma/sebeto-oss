/**
 * Webhook presets: pure functions that turn an alert payload into one normalised event
 * (docs/28 v0.4 Plan.md §D). No I/O; tests use fixtures in __fixtures__/.
 *
 * Every preset returns ONE event per call (Alertmanager and Grafana group their alerts already:
 * one ticket per alert group). `resolved` = the alert is over (Alertmanager/Grafana "resolved",
 * Uptime Kuma heartbeat up, Zabbix recovery).
 */
import type { WebhookPreset } from '@sebeto/shared';

export interface AlertEvent {
  title: string;
  summary: string;
  severity: string;
  host: string;
  /** 'firing' or 'resolved'. */
  status: 'firing' | 'resolved';
  /** Key used to recognise repeats of the same alert ('' = none found). */
  dedupeKey: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Dotted path lookup ("alerts.0.labels.instance"); returns undefined when missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (part === '') return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

/** A scalar as text ('' for objects, arrays, null, undefined). */
export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** First non-empty scalar among the given paths. */
function first(obj: unknown, ...paths: string[]): string {
  for (const p of paths) {
    const v = str(getPath(obj, p)).trim();
    if (v) return v;
  }
  return '';
}

const RESOLVED_WORDS = new Set(['resolved', 'ok', 'up', 'recovered', 'recovery', 'normal', 'closed', 'inactive']);

function isResolvedWord(s: string): boolean {
  return RESOLVED_WORDS.has(s.trim().toLowerCase());
}

/** Generic JSON: common field names used by scripts, Teams/Slack workflows and most tools. */
export function parseGeneric(p: unknown): AlertEvent {
  const title = first(p, 'title', 'subject', 'name', 'alertname', 'event', 'summary', 'message', 'text');
  const summary = first(p, 'summary', 'message', 'description', 'text', 'body', 'details');
  const severity = first(p, 'severity', 'priority', 'level');
  const host = first(p, 'host', 'hostname', 'instance', 'server', 'device', 'source');
  const statusText = first(p, 'status', 'state');
  return {
    title: title || 'Webhook alert',
    summary: summary === title ? '' : summary,
    severity, host,
    status: isResolvedWord(statusText) || getPath(p, 'resolved') === true ? 'resolved' : 'firing',
    dedupeKey: first(p, 'id', 'fingerprint', 'eventId', 'event_id', 'incident_id', 'key') || title,
  };
}

/** Prometheus Alertmanager webhook (version 4): { status, groupKey, alerts[], commonLabels, commonAnnotations }. */
export function parseAlertmanager(p: unknown): AlertEvent {
  const alerts = Array.isArray(getPath(p, 'alerts')) ? (getPath(p, 'alerts') as unknown[]) : [];
  const a0 = alerts[0];
  const alertname = first(p, 'commonLabels.alertname', 'groupLabels.alertname') || first(a0, 'labels.alertname');
  const summary = first(p, 'commonAnnotations.summary', 'commonAnnotations.description') || first(a0, 'annotations.summary', 'annotations.description');
  const instances = [...new Set(alerts.map((a) => first(a, 'labels.instance', 'labels.host', 'labels.node')).filter(Boolean))];
  const host = first(p, 'commonLabels.instance') || instances.slice(0, 5).join(', ');
  const status = first(p, 'status') || first(a0, 'status');
  const firingCount = alerts.filter((a) => first(a, 'status') === 'firing').length;
  return {
    title: alertname ? `${alertname}${alerts.length > 1 ? ` (${alerts.length} alerts)` : ''}` : 'Alertmanager alert',
    summary,
    severity: first(p, 'commonLabels.severity') || first(a0, 'labels.severity'),
    host,
    status: status === 'resolved' || (alerts.length > 0 && firingCount === 0 && status !== 'firing') ? 'resolved' : 'firing',
    dedupeKey: first(p, 'groupKey') || first(a0, 'fingerprint') || alertname,
  };
}

/** Grafana unified alerting webhook: { title, message, state|status, alerts[]: { labels, fingerprint, status } }. */
export function parseGrafana(p: unknown): AlertEvent {
  const alerts = Array.isArray(getPath(p, 'alerts')) ? (getPath(p, 'alerts') as unknown[]) : [];
  const a0 = alerts[0];
  const rawTitle = first(p, 'title', 'ruleName') || first(a0, 'labels.alertname');
  // Grafana titles look like "[FIRING:1] HighCPU (prod)"; keep the readable part.
  const title = rawTitle.replace(/^\[(FIRING|RESOLVED)(:\d+)?\]\s*/i, '');
  const status = first(p, 'status', 'state') || first(a0, 'status');
  return {
    title: title || 'Grafana alert',
    summary: first(p, 'message') || first(a0, 'annotations.summary', 'annotations.description'),
    severity: first(p, 'commonLabels.severity') || first(a0, 'labels.severity'),
    host: first(p, 'commonLabels.instance') || first(a0, 'labels.instance', 'labels.host'),
    status: isResolvedWord(status) || /^\[RESOLVED/i.test(rawTitle) ? 'resolved' : 'firing',
    dedupeKey: first(p, 'groupKey') || first(a0, 'fingerprint') || title,
  };
}

/** Uptime Kuma webhook: { heartbeat: { status 0 down / 1 up, msg }, monitor: { id, name, url, hostname }, msg }. */
export function parseUptimeKuma(p: unknown): AlertEvent {
  const name = first(p, 'monitor.name') || 'Monitor';
  const statusRaw = getPath(p, 'heartbeat.status');
  const up = statusRaw === 1 || statusRaw === '1';
  return {
    title: `${name} is ${up ? 'up' : 'down'}`,
    summary: first(p, 'heartbeat.msg', 'msg'),
    severity: up ? 'info' : 'critical',
    host: first(p, 'monitor.hostname', 'monitor.url'),
    status: up ? 'resolved' : 'firing',
    dedupeKey: first(p, 'monitor.id') || name,
  };
}

/**
 * Zabbix webhook media type (the owner's script sends JSON): { subject, message, severity, host,
 * eventid, recovery | status ("PROBLEM"/"RESOLVED"/"OK") }.
 */
export function parseZabbix(p: unknown): AlertEvent {
  const subject = first(p, 'subject', 'event_name', 'name', 'trigger_name');
  const status = first(p, 'status', 'event_status', 'event_value');
  const recoveryFlag = getPath(p, 'recovery');
  const resolved = recoveryFlag === true || recoveryFlag === 'true' || recoveryFlag === 1 || recoveryFlag === '1'
    || isResolvedWord(status) || /^(resolved|ok)\b/i.test(subject) || status === '0';
  return {
    title: subject.replace(/^(problem|resolved|ok):\s*/i, '') || 'Zabbix event',
    summary: first(p, 'message', 'event_opdata', 'description'),
    severity: first(p, 'severity', 'event_severity', 'trigger_severity'),
    host: first(p, 'host', 'host_name', 'hostname', 'host_ip'),
    status: resolved ? 'resolved' : 'firing',
    // Recovery events carry the problem's id in event_id/problem_id on some media types.
    dedupeKey: first(p, 'problem_eventid', 'problem_id', 'eventid', 'event_id') || subject,
  };
}

export const PRESET_PARSERS: Record<WebhookPreset, (p: unknown) => AlertEvent> = {
  generic: parseGeneric,
  alertmanager: parseAlertmanager,
  grafana: parseGrafana,
  'uptime-kuma': parseUptimeKuma,
  zabbix: parseZabbix,
};

/** Parse with a preset; `dedupeField` (a dotted path) overrides the preset's key when present. */
export function parseWithPreset(preset: WebhookPreset, payload: unknown, dedupeField?: string): AlertEvent {
  const ev = PRESET_PARSERS[preset](payload);
  if (dedupeField?.trim()) {
    const v = getPath(payload, dedupeField.trim());
    const key = typeof v === 'object' && v !== null ? JSON.stringify(v) : str(v);
    if (key) ev.dedupeKey = key;
  }
  ev.dedupeKey = ev.dedupeKey.slice(0, 500);
  return ev;
}

/** A sample payload per preset (Test button without a payload, docs). */
export const PRESET_SAMPLES: Record<WebhookPreset, unknown> = {
  generic: { title: 'Disk almost full', message: 'C: on FS01 has 4% free space', severity: 'warning', host: 'fs01.corp.local' },
  alertmanager: {
    version: '4', status: 'firing', receiver: 'sebeto', groupKey: '{}:{alertname="DiskFull"}',
    groupLabels: { alertname: 'DiskFull' },
    commonLabels: { alertname: 'DiskFull', severity: 'critical', instance: 'fs01:9100' },
    commonAnnotations: { summary: 'Disk C: on fs01 is 96% full' },
    alerts: [{ status: 'firing', labels: { alertname: 'DiskFull', severity: 'critical', instance: 'fs01:9100' }, annotations: { summary: 'Disk C: on fs01 is 96% full' }, startsAt: '2026-11-12T07:58:00Z', fingerprint: 'a1b2c3d4e5f60718' }],
  },
  grafana: {
    receiver: 'sebeto', status: 'firing', state: 'alerting', title: '[FIRING:1] High CPU (prod)', message: 'CPU above 90% for 10 minutes on web02',
    groupKey: '{}:{alertname="High CPU"}', commonLabels: { alertname: 'High CPU', severity: 'warning', instance: 'web02' },
    alerts: [{ status: 'firing', labels: { alertname: 'High CPU', instance: 'web02' }, annotations: { summary: 'CPU above 90%' }, fingerprint: '9f8e7d6c5b4a3921' }],
  },
  'uptime-kuma': {
    heartbeat: { status: 0, msg: 'Connection timeout', time: '2026-11-12 08:00:00' },
    monitor: { id: 7, name: 'Intranet', url: 'https://intranet.corp.local', hostname: null },
    msg: '[Intranet] [🔴 Down] Connection timeout',
  },
  zabbix: {
    subject: 'Problem: High memory utilization on SRV-DB01', message: 'Memory utilization is 95% (threshold 90%)', severity: 'High',
    host: 'SRV-DB01', eventid: '418812', status: 'PROBLEM', recovery: false,
  },
};
