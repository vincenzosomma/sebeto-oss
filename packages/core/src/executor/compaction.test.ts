import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AuditEvent, Message, RuntimeAdapter, TicketRun } from '@sebeto/shared';
import { BRIEF_MAX_CHARS, buildCompactionBrief, listTicketFiles, needsCompaction } from './compaction.js';
import { createExecutor } from './executor.js';
import { createFakes } from './testing/fakes.js';

const msg = (role: Message['role'], text: string, author = 'Analyst'): Message => ({ id: text, ticketId: 't', runId: null, role, author, text, createdAt: '' });
const ev = (kind: AuditEvent['kind'], summary: string): AuditEvent => ({ id: summary, ticketId: 't', runId: null, kind, summary, data: null, createdAt: '' });

describe('compaction helpers', () => {
  it('compacts only runtimes without their own compaction, at 70% of the window', () => {
    expect(needsCompaction(11_500, 16_384, false)).toBe(true);
    expect(needsCompaction(11_000, 16_384, false)).toBe(false);
    expect(needsCompaction(190_000, 200_000, true)).toBe(false); // Claude Code compacts itself
    expect(needsCompaction(99_999, undefined, false)).toBe(false); // window unknown
  });

  it('builds a brief from goal, chat, actions, files and pending permissions', () => {
    const brief = buildCompactionBrief({
      ticket: { number: 12, title: 'Spooler checklist', goal: 'Write checklist.md for restarting the spooler.' },
      messages: [msg('system', 'Ticket created'), msg('user', 'Please add a rollback step', 'You'), msg('agent', 'Added step 4.')],
      events: [ev('status', 'Moved to In progress'), ev('tool', 'Wrote checklist.md'), ev('snapshot', 'Changed 1 file: checklist.md')],
      files: ['checklist.md', 'notes/a.txt'],
      pending: [{ title: 'Permission needed: run a command' } as never],
    });
    expect(brief).toContain('[Context note from Sebeto]');
    expect(brief).toContain('Ticket T-12: Spooler checklist');
    expect(brief).toContain('- Owner: Please add a rollback step');
    expect(brief).toContain('- Analyst: Added step 4.');
    expect(brief).not.toContain('Ticket created'); // system messages skipped
    expect(brief).toContain('- Wrote checklist.md');
    expect(brief).not.toContain('Moved to In progress'); // only actions, not status noise
    expect(brief).toContain('Files in your folder: checklist.md, notes/a.txt');
    expect(brief).toContain("Waiting for the owner's permission: Permission needed: run a command");
  });

  it('stays short with long histories', () => {
    const many = Array.from({ length: 200 }, (_, i) => msg('agent', `message ${i} ${'x'.repeat(2000)}`));
    const brief = buildCompactionBrief({ ticket: { number: 1, title: 't', goal: 'g'.repeat(5000) }, messages: many, events: [], files: [], pending: [] });
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(brief).toContain('message 199');
    expect(brief).not.toContain('message 150 ');
  });

  it('lists ticket files without Sebeto folders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-compact-'));
    try {
      fs.mkdirSync(path.join(dir, '.sebeto-git'));
      fs.writeFileSync(path.join(dir, '.sebeto-git', 'HEAD'), 'x');
      fs.mkdirSync(path.join(dir, '.sebeto'));
      fs.writeFileSync(path.join(dir, '.sebeto', 'ollama-s.json'), '[]');
      fs.mkdirSync(path.join(dir, 'logs'));
      fs.writeFileSync(path.join(dir, 'logs', 'run.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'checklist.md'), 'x');
      expect(listTicketFiles(dir)).toEqual(['checklist.md', 'logs/run.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('executor compaction', () => {
  /** A local-model-like runtime that reports a nearly full context on its first run. */
  function localRuntime(prompts: string[], contexts: number[]): RuntimeAdapter {
    return {
      id: 'ollama', displayName: 'Local', capabilities: { tools: true, resume: true, costReport: true, contextWindow: 1_000, nativeCompaction: false },
      detect: async () => ({ installed: true }), models: async () => ['m'],
      async *run(r: TicketRun): AsyncGenerator<AgentEvent> {
        prompts.push(r.prompt);
        yield { kind: 'session', externalSessionId: r.externalSessionId ?? r.newExternalSessionId! };
        yield { kind: 'text', text: 'Working on it.' };
        yield { kind: 'usage', tokensIn: 10, tokensOut: 5, costUsd: 0, contextTokens: contexts.shift() ?? 100 };
        yield { kind: 'done', costUsd: 0 };
      },
    };
  }

  it('closes a full session and starts the next one from a brief', async () => {
    const prompts: string[] = [];
    const f = createFakes({ adapters: [localRuntime(prompts, [850, 200])] });
    const agent = f.addAgent({ runtime: 'ollama' });
    const t = f.addTicket({ agentId: agent.id, title: 'Spooler checklist', goal: 'Write checklist.md' });
    const ex = createExecutor(f.ctx);

    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    ex.tick();
    await ex.idle();
    const first = f.sessions.get(f.tickets.get(t.id)!.currentSessionId!)!;
    expect(first.endedAt).not.toBeNull();
    expect(f.audit.some((e) => /^Context 85% full: the next run starts a fresh session/.test(e.summary))).toBe(true);

    f.ctx.queue.enqueue('run.reply', { ticketId: t.id, text: 'Add a rollback step' });
    ex.tick();
    await ex.idle();
    const second = f.sessions.get(f.tickets.get(t.id)!.currentSessionId!)!;
    expect(second.id).not.toBe(first.id);
    expect(second.reason).toBe('compaction');
    expect(prompts[1]).toMatch(/^\[Context note from Sebeto\]/);
    expect(prompts[1]).toContain('Ticket T-');
    expect(prompts[1]!.endsWith('Add a rollback step')).toBe(true);

    // Below the threshold: the session continues and no brief is added again.
    f.ctx.queue.enqueue('run.reply', { ticketId: t.id, text: 'Thanks' });
    ex.tick();
    await ex.idle();
    expect(f.tickets.get(t.id)!.currentSessionId).toBe(second.id);
    expect(prompts[2]).toBe('Thanks');
  });
});
