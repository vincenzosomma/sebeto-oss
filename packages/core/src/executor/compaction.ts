/**
 * Context compaction (docs/15 Architecture Review.md item 11).
 *
 * Runtimes that compact their own context (Claude Code) are left alone. For the others (Ollama),
 * when a run used most of the model's context window, the session is closed and the next run
 * starts a fresh session whose first prompt begins with a brief Sebeto writes from its own records:
 * goal, recent chat, recent actions, files in the folder and open permission requests.
 * No model call is needed, so it costs nothing and cannot fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AuditEvent, Message, PermissionRequest, Ticket } from '@sebeto/shared';

/** Compact when the last prompt used this share of the context window. */
export const COMPACT_AT = 0.7;
export const BRIEF_MAX_CHARS = 6_000;
const MSG_MAX = 600;

/** Whether a run's context use calls for a fresh session. Exported for tests. */
export function needsCompaction(contextTokens: number, contextWindow: number | undefined, nativeCompaction: boolean | undefined): boolean {
  if (nativeCompaction || !contextWindow || contextWindow <= 0 || !Number.isFinite(contextTokens)) return false;
  return contextTokens >= contextWindow * COMPACT_AT;
}

/** Files in the ticket folder (relative, max 50), skipping Sebeto's own folders. */
export function listTicketFiles(folder: string, max = 50): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (prefix === '' && /^\.(sebeto|sebeto-git|git)$/i.test(e.name)) continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/`);
      else out.push(rel);
    }
  };
  walk(folder, '');
  return out;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The brief that opens a compacted session. Exported for tests. */
export function buildCompactionBrief(input: {
  ticket: Pick<Ticket, 'number' | 'title' | 'goal'>;
  messages: Message[];
  events: AuditEvent[];
  files: string[];
  pending: PermissionRequest[];
}): string {
  const { ticket } = input;
  const parts: string[] = [
    `[Context note from Sebeto] Your earlier conversation on this ticket was closed because it filled the model's memory. ` +
      `This is a summary of where things stand; continue from here. Files you wrote are still in your folder.`,
    `Ticket T-${ticket.number}: ${ticket.title}\nGoal: ${clip(ticket.goal, 1200)}`,
  ];
  const tail: string[] = [];
  const actions = input.events.filter((e) => e.kind === 'tool' || e.kind === 'snapshot' || e.kind === 'permission').slice(-15);
  if (actions.length) tail.push(`Recent actions:\n${actions.map((e) => `- ${clip(e.summary, 160)}`).join('\n')}`);
  if (input.files.length) tail.push(`Files in your folder: ${clip(input.files.join(', '), 800)}`);
  if (input.pending.length) tail.push(`Waiting for the owner's permission: ${clip(input.pending.map((p) => p.title).join('; '), 400)}`);

  // The chat gets the room that is left, newest messages first (they matter most).
  let room = BRIEF_MAX_CHARS - [...parts, ...tail].join('\n\n').length - 60;
  const chatLines: string[] = [];
  for (const m of input.messages.filter((x) => x.role !== 'system').slice(-12).reverse()) {
    const line = `- ${m.role === 'user' ? 'Owner' : m.author}: ${clip(m.text, MSG_MAX)}`;
    if (line.length + 1 > room) break;
    chatLines.unshift(line);
    room -= line.length + 1;
  }
  if (chatLines.length) parts.push(`Recent conversation (oldest first):\n${chatLines.join('\n')}`);
  const brief = [...parts, ...tail].join('\n\n');
  return brief.length > BRIEF_MAX_CHARS ? `${brief.slice(0, BRIEF_MAX_CHARS - 20)}\n[summary shortened]` : brief;
}
