import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../triggers/testing/harness.js';
import { createTicket, deleteTicket, getTicketDetail, listTickets, postMessage, purgeTicket, restoreTicket } from './tickets.js';

let h: Harness;
beforeEach(() => { h = createHarness(); h.ctx.repos.agents.create({ name: 'Ops', runtime: 'mock' }); });
afterEach(() => h.close());

describe('Deleted tickets', () => {
  it('delete hides it everywhere, restore brings it back, delete forever removes row and folder', async () => {
    const a = await createTicket(h.ctx, { title: 'Return laptop', goal: 'Unassign it' });
    const b = await createTicket(h.ctx, { title: 'Keep me', goal: 'x' });
    fs.mkdirSync(a.folder, { recursive: true });
    fs.writeFileSync(path.join(a.folder, 'notes.md'), 'hi');

    const d = deleteTicket(h.ctx, a.id);
    expect(d.deletedAt).toBeTruthy();
    expect(listTickets(h.ctx, {}).items.map((t) => t.id)).toEqual([b.id]);
    expect(listTickets(h.ctx, { deleted: true }).items.map((t) => t.id)).toEqual([a.id]);
    expect(h.events.some((e) => e.type === 'ticket.deleted' && e.ticketId === a.id)).toBe(true);
    // Everyday actions are refused until restored.
    expect(() => getTicketDetail(h.ctx, a.id)).toThrow(/Restore it first/);
    await expect(Promise.resolve().then(() => postMessage(h.ctx, a.id, 'go'))).rejects.toThrow(/Restore it first/);
    // Not "forever" while it's live.
    await expect(purgeTicket(h.ctx, b.id)).rejects.toThrow(/Delete the ticket first/);

    expect(restoreTicket(h.ctx, a.id).deletedAt).toBeNull();
    expect(listTickets(h.ctx, {}).items.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());

    deleteTicket(h.ctx, a.id);
    await purgeTicket(h.ctx, a.id);
    expect(h.ctx.repos.tickets.get(a.id)).toBeUndefined();
    expect(fs.existsSync(a.folder)).toBe(false);
    expect(h.security.map((s) => s.action)).toEqual(expect.arrayContaining(['ticket.trashed', 'ticket.restored']));
  });
});
