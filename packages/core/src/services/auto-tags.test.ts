import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../triggers/testing/harness.js';
import { autoTags, withAutoTags } from './auto-tags.js';
import { createTicket } from './tickets.js';

describe('autoTags', () => {
  it('tags real #help-desk requests', () => {
    expect(autoTags({ title: 'Hi, could I please get access to download and install Python 3.12 for windows' })).toEqual(['software', 'access']);
    expect(autoTags({ title: 'Check firewall quarantine status for MAC 00:11:22:33:44' })).toEqual(['network']);
    expect(autoTags({ title: 'please could I have a DHCP reservation?' })).toEqual(['network']);
    expect(autoTags({ title: 'Return laptop', goal: 'Leaver: unassign the MacBook in the asset register' })).toContain('hardware');
  });
  it('matches whole words only and caps the number of tags', () => {
    expect(autoTags({ title: 'happy birthday' })).toEqual([]); // "app" inside a word does not count
    expect(autoTags({ title: 'vpn wifi printer laptop password phishing' }).length).toBe(3);
  });
  it('keeps the ticket\'s own tags first, without duplicates', () => {
    expect(withAutoTags(['help-desk', 'network'], { title: 'VPN drops on wifi' })).toEqual(['help-desk', 'network']);
  });
});

describe('createTicket with auto tags', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); h.ctx.repos.agents.create({ name: 'Ops', runtime: 'mock' }); });
  afterEach(() => h.close());

  it('adds category tags to new tickets', async () => {
    const t = await createTicket(h.ctx, { title: 'Reset my password', goal: 'Locked out of Gmail', tags: ['help-desk'] });
    expect(t.tags).toEqual(['help-desk', 'access', 'email']);
  });
});
