import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './testing/harness.js';
import { createTrigger, fire, slackGroupKey, slackIncoming } from './service.js';

export const EDR_DEDUPE = 'EDR Alert – (.+?)\\*[\\s\\S]*?\\*Endpoint:\\* ([^\\n]+)';
const alert = (title: string, endpoint: string, detected: string) =>
  `:large_yellow_circle: *EDR Alert – ${title}*\n*Severity:* MEDIUM | *Status:* NEW | *Verdict:* UNDEFINED\n*Endpoint:* ${endpoint}\n*Source:* Anomaly Detection\n*Detected:* ${detected}\n*Storyline:* F91311E1E0ABA44B`;

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.ctx.repos.agents.create({ name: 'Security Lead', runtime: 'mock' });
  (h.ctx as { connectors?: unknown }).connectors = { get: (id: string) => (id === 'conn' ? { id, catalogId: 'slack' } : undefined), settingsFor: async () => ({}) };
});
afterEach(() => h.close());

describe('Slack rule: group repeats (dedupeOn)', () => {
  it('keys on the capture groups', () => {
    expect(slackGroupKey(EDR_DEDUPE, alert('First Seen RMM Tool Execution', 'LAPTOP-2891KSSN (WINDOWS)', '12:52:00.392Z'))).toBe('first seen rmm tool execution|laptop-2891kssn (windows)');
    expect(slackGroupKey(EDR_DEDUPE, 'Security Radar health: healthy')).toBeNull();
    expect(slackGroupKey('', 'anything')).toBeNull();
  });

  it('the same alert posted again comments on the open ticket; another endpoint opens a new one', async () => {
    const bp = { title: '{{title}}', goal: '{{summary}}', teamId: null, agentId: null, projectId: null, tags: ['edr-alert'], costCapUsd: null, autoStart: false };
    const { trigger } = await createTrigger(h.ctx, {
      name: 'EDR', dedupeWindowMinutes: 7 * 24 * 60, blueprint: bp,
      config: { kind: 'slack', connectorId: 'conn', channel: 'C0SEC0001', fromContains: '', textContains: 'EDR Alert', includeBots: true, pollMinutes: 2, dedupeOn: EDR_DEDUPE },
    });
    const send = (ts: string, text: string) => fire(h.ctx, trigger.id, slackIncoming({ channel: 'security-alerts', channelId: 'C0SEC0001', ts, from: 'EDR_Alert_Bot', text, link: null, bot: true, groupKey: slackGroupKey(EDR_DEDUPE, text) }));
    const a = await send('1.1', alert('First Seen RMM Tool Execution', 'LAPTOP-2891KSSN (WINDOWS)', '12:52:00.392Z'));
    const b = await send('1.2', alert('First Seen RMM Tool Execution', 'LAPTOP-2891KSSN (WINDOWS)', '12:52:00.393Z'));
    const c = await send('1.3', alert('First Seen RMM Tool Execution', 'TanviTambePC (WINDOWS)', '10:12:16.975Z'));
    expect([a.outcome, b.outcome, c.outcome]).toEqual(['created', 'commented', 'created']);
    expect(b.ticketId).toBe(a.ticketId);
    expect(h.ctx.repos.tickets.get(a.ticketId!)!.title).toBe('EDR Alert – First Seen RMM Tool Execution');
  });
});
