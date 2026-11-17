import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../triggers/testing/harness.js';
import { createTicket, getTicketDetail } from './tickets.js';

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => h.close());

describe('Ticket detail: agent monthly budget', () => {
  it('reports the assigned agent budget and this month spend, so the budget card can raise the right limit', async () => {
    const agent = h.ctx.repos.agents.create({ name: 'Sysadmin', runtime: 'mock', monthlyBudgetUsd: 20 });
    const t = await createTicket(h.ctx, { title: 'Check firewall', goal: 'x', agentId: agent.id });
    const d = getTicketDetail(h.ctx, t.id);
    expect(d.agentBudget).toEqual({ agentId: agent.id, name: 'Sysadmin', monthlyBudgetUsd: 20, spentUsd: 0 });
  });

  it('is absent for a ticket with no agent', async () => {
    const t = await createTicket(h.ctx, { title: 'Unassigned', goal: 'x' });
    expect(getTicketDetail(h.ctx, t.id).agentBudget).toBeUndefined();
  });
});
