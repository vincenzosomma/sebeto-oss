import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../triggers/testing/harness.js';
import { MAX_HANDOFFS, applyHandoff, requestHandoff, resolveHandoffTarget } from './handoff.js';
import { createTicket } from './tickets.js';

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => h.close());

function setup() {
  const { repos } = h.ctx;
  const desk = repos.teams!.create({ slug: 'service-desk', name: 'Service Desk', description: '', color: 'blue', leadAgentId: null, routingHints: 'laptop password' });
  const infra = repos.teams!.create({ slug: 'infrastructure', name: 'Infrastructure', description: '', color: 'green', leadAgentId: null, routingHints: 'vpn firewall dhcp network' });
  const sd = repos.agents.create({ name: 'Service Desk Lead', role: 'Service desk', runtime: 'mock', teamId: desk.id });
  const net = repos.agents.create({ name: 'Network Engineer', role: 'Network engineer', runtime: 'mock', teamId: infra.id });
  return { desk, infra, sd, net };
}

describe('hand-offs', () => {
  it('resolves teams, people and the Chief of Staff; unknown names list who exists', () => {
    const { infra, net, sd } = setup();
    expect(resolveHandoffTarget(h.ctx, 'Chief of Staff', sd.id)).toEqual({ kind: 'chief' });
    expect(resolveHandoffTarget(h.ctx, 'the Infrastructure team', sd.id)).toMatchObject({ kind: 'team', team: { id: infra.id } });
    expect(resolveHandoffTarget(h.ctx, 'network engineer', sd.id)).toMatchObject({ kind: 'agent', agent: { id: net.id } });
    expect(resolveHandoffTarget(h.ctx, 'Service Desk Lead', sd.id)).toMatchObject({ error: expect.stringContaining('Network Engineer') }); // not to yourself
  });

  it('applies after the run: new team + agent, note on the chat, next agent queued with the note', async () => {
    const { desk, infra, sd, net } = setup();
    const t = await createTicket(h.ctx, { title: 'HELP-587 DHCP reservation', goal: 'Reserve an IP for the lab printer', agentId: sd.id, teamId: desk.id });
    h.ctx.repos.messages.create({ ticketId: t.id, role: 'agent', author: 'Service Desk Lead', text: 'MAC is 28:2d:06:07:32:f6' });
    requestHandoff(h.ctx, t.id, { target: { kind: 'team', team: h.ctx.repos.teams!.get(infra.id)! }, note: 'Needs a DHCP reservation on the firewall', fromAgentId: sd.id });
    await applyHandoff(h.ctx, t.id);
    const after = h.ctx.repos.tickets.get(t.id)!;
    expect(after).toMatchObject({ agentId: net.id, teamId: infra.id, currentSessionId: null });
    const msgs = h.ctx.repos.messages.listForTicket(t.id, { limit: 20 }).items;
    expect(msgs.find((m) => m.role === 'handoff')?.text).toContain('Needs a DHCP reservation');
    const job = h.ctx.queue.claim('test')!;
    expect(job).toMatchObject({ kind: 'run.start', payload: { ticketId: t.id } });
    expect(job.payload.text).toContain('handed over to you by Service Desk Lead');
    expect(job.payload.text).toContain('28:2d:06:07:32:f6');
  });

  it('stops after the limit and asks the owner', async () => {
    const { desk, infra, sd } = setup();
    const t = await createTicket(h.ctx, { title: 'Ping-pong', goal: 'x', agentId: sd.id, teamId: desk.id });
    for (let i = 0; i < MAX_HANDOFFS; i++) h.ctx.repos.audit.append({ ticketId: t.id, kind: 'info', summary: 'Handed over', data: { handoff: { n: i } } });
    requestHandoff(h.ctx, t.id, { target: { kind: 'team', team: h.ctx.repos.teams!.get(infra.id)! }, note: 'yours again', fromAgentId: sd.id });
    await applyHandoff(h.ctx, t.id);
    expect(h.ctx.repos.tickets.get(t.id)).toMatchObject({ agentId: sd.id, status: 'needs_you' });
  });
});
