/** "Always allow this command": trusted commands in the permission gate. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS } from '@sebeto/shared';
import type { PermissionKey } from '@sebeto/shared';
import { createPermissionGate } from './index.js';
import { createFakes } from './test-fakes.js';

const CMD = { shell: 'powershell', command: 'Get-PSDrive -PSProvider FileSystem' };

function setup(perms: Partial<Record<PermissionKey, 'allow' | 'ask' | 'never'>> = {}) {
  const f = createFakes();
  const gate = createPermissionGate({ repos: f.repos, state: f.state, queue: f.queue, bus: f.bus });
  const agent = f.addAgent({ permissions: { ...DEFAULT_PERMISSIONS, ...perms } });
  const ticket = f.addTicket('/tmp/x', { agentId: agent.id });
  const run = f.addRun(ticket.id);
  const base = { ticketId: ticket.id, runId: run.id, agentId: agent.id, title: 'Permission needed: run a command', detail: `Reason: disk\n\n${CMD.command}` };
  return { f, gate, agent, ticket, run, base };
}

describe('trusted commands', () => {
  it('a script.run request keeps the command; "always" allows it and trusts it', () => {
    const { f, gate, base } = setup();
    const d = gate.check({ ...base, key: 'script.run', command: CMD });
    expect(d.outcome).toBe('pending');
    if (d.outcome !== 'pending') return;
    expect(d.request.command).toEqual(CMD);

    const decided = gate.decide(d.request.id, 'always');
    expect(decided.state).toBe('allowed');
    expect(decided.alwaysAllowed).toBe(true);
    expect(f.trusted.map((t) => [t.shell, t.command, t.requestId])).toEqual([[CMD.shell, CMD.command, d.request.id]]);
    expect(f.bus.events.some((e) => e.type === 'trusted.changed')).toBe(true);
    expect(f.audit.some((e) => e.summary.startsWith('Always allowed'))).toBe(true);
    // Resumes the agent like an allow.
    expect(f.queue.jobs.some((j) => j.kind === 'run.permission')).toBe(true);
  });

  it('a trusted command runs without asking: any ticket, any reason, surrounding spaces ignored', () => {
    const { f, gate, base } = setup();
    f.repos.trusted.add({ ...CMD });
    const other = f.addTicket('/tmp/y');
    for (const input of [
      { ...base, key: 'script.run' as const, command: CMD },
      { ...base, ticketId: other.id, detail: 'Reason: something else', key: 'script.run' as const, command: { ...CMD, command: `  ${CMD.command}\n` } },
    ]) {
      expect(gate.check(input)).toEqual({ outcome: 'allow' });
    }
    expect(f.permissions.size).toBe(0);
    expect(f.audit.filter((e) => e.summary.startsWith('Trusted command')).length).toBe(2);
  });

  it('matches exactly: another shell or another command still asks', () => {
    const { f, gate, base } = setup();
    f.repos.trusted.add({ ...CMD });
    expect(gate.check({ ...base, key: 'script.run', command: { ...CMD, shell: 'cmd' } }).outcome).toBe('pending');
    expect(gate.check({ ...base, key: 'script.run', detail: 'x', command: { ...CMD, command: `${CMD.command}; Remove-Item x` } }).outcome).toBe('pending');
  });

  it('never applies after untrusted input, to production changes, or when the agent has "never"', () => {
    const { f, gate, base } = setup();
    f.repos.trusted.add({ ...CMD });
    expect(gate.check({ ...base, key: 'script.run', command: CMD, untrustedInput: true, provenance: 'evil.example' }).outcome).toBe('pending');
    expect(gate.check({ ...base, key: 'prod.change', detail: 'p', command: CMD }).outcome).toBe('pending');

    const never = setup({ 'script.run': 'never' });
    never.f.repos.trusted.add({ ...CMD });
    expect(never.gate.check({ ...never.base, key: 'script.run', command: CMD }).outcome).toBe('deny');
  });

  it('refuses "always" for anything but a plain command', () => {
    const { gate, base } = setup();
    const email = gate.check({ ...base, key: 'email.send' });
    const prod = gate.check({ ...base, key: 'prod.change', detail: 'prod', command: CMD });
    for (const d of [email, prod]) {
      expect(d.outcome).toBe('pending');
      if (d.outcome !== 'pending') continue;
      expect(d.request.command).toBeNull();
      expect(() => gate.decide(d.request.id, 'always')).toThrow(/plain system command/);
    }
  });

  it('removing a trusted command makes it ask again', () => {
    const { f, gate, base } = setup();
    const t = f.repos.trusted.add({ ...CMD });
    expect(f.repos.trusted.remove(t.id)).toBe(true);
    expect(gate.check({ ...base, key: 'script.run', command: CMD }).outcome).toBe('pending');
  });
});
