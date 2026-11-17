/**
 * Reading Claude Code session files (~/.claude/projects/<encoded cwd>/<session id>.jsonl) for the
 * session library (v0.4 §A). READ-ONLY: nothing here writes to, renames or deletes those files.
 * Files can be large, so only the first and last chunks are read for the summary and the preview.
 *
 * The jsonl format is Claude Code's internal format. Lines we use:
 *   {"type":"user","message":{"role":"user","content":"…" | [{type:"text"|"tool_result",…}]},"cwd","sessionId","timestamp","isSidechain","isMeta"}
 *   {"type":"assistant","message":{"id","model","content":[{type:"text"|"tool_use"|"thinking",…}]},…}
 *   {"type":"summary","summary":"…"}
 * Everything else (attachments, queue operations, cost state…) is ignored.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionTranscriptTurn } from '@sebeto/shared';

/** Bytes read from the start and from the end of a file. Files up to HEAD+TAIL are read whole. */
export const HEAD_BYTES = 512 * 1024;
export const TAIL_BYTES = 512 * 1024;
export const MAX_TITLE = 100;
export const MAX_SUMMARY = 600;
export const MAX_TURN_TEXT = 1_200;

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Claude Code's config folder: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), '.claude');
}

/**
 * The folder name Claude Code uses for a working directory under ~/.claude/projects: every character
 * that is not a letter or digit becomes '-' (C:\Users\me\.sebeto → C--Users-me--sebeto).
 */
export function encodeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export const isSessionFileName = (name: string): boolean => SESSION_FILE_RE.test(name);

export interface ClaudeSessionInfo {
  sessionId: string;
  cwd: string | null;
  title: string;
  summary: string;
  model: string | null;
  messageCount: number;
  startedAt: string;
  lastActivityAt: string;
  /** Only part of the file was read (very large file): counts are for the part read. */
  partial: boolean;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
export function clip(s: string, max: number): string {
  const t = oneLine(s);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

interface Line { [k: string]: unknown }

/** Read the head and tail chunks of a file and parse their complete JSON lines. */
async function readLines(file: string): Promise<{ head: Line[]; tail: Line[]; partial: boolean; size: number; mtime: Date }> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size, mtime } = await handle.stat();
    const parse = (text: string): Line[] => {
      const out: Line[] = [];
      for (const raw of text.split('\n')) {
        const l = raw.trim();
        if (!l.startsWith('{')) continue;
        try {
          const v = JSON.parse(l) as unknown;
          if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Line);
        } catch { /* a cut or broken line */ }
      }
      return out;
    };
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, 0);
      return { head: parse(buf.toString('utf8')), tail: [], partial: false, size, mtime };
    }
    const head = Buffer.alloc(HEAD_BYTES);
    await handle.read(head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    const headText = head.toString('utf8');
    const tailText = tail.toString('utf8');
    // Drop the cut line at the end of the head and at the start of the tail.
    return {
      head: parse(headText.slice(0, headText.lastIndexOf('\n') + 1)),
      tail: parse(tailText.slice(tailText.indexOf('\n') + 1)),
      partial: true, size, mtime,
    };
  } finally {
    await handle.close();
  }
}

/** Plain text of a user message, or null when it is not a real prompt (tool results, commands, reminders). */
function userText(line: Line): string | null {
  if (line.isMeta === true || line.isSidechain === true) return null;
  const msg = line.message as { content?: unknown } | undefined;
  const c = msg?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    text = c.filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text).join('\n');
  }
  text = text.trim();
  // Slash commands, command output and injected reminders start with a tag.
  if (!text || text.startsWith('<')) return null;
  return text;
}

function assistantBlocks(line: Line): { id: string | null; model: string | null; text: string; tools: string[] } | null {
  if (line.isSidechain === true) return null;
  const msg = line.message as { id?: unknown; model?: unknown; content?: unknown } | undefined;
  if (!msg) return null;
  const blocks = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
  const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n').trim();
  const tools = blocks.filter((b) => b?.type === 'tool_use' && typeof b.name === 'string').map((b) => b.name as string);
  return {
    id: typeof msg.id === 'string' ? msg.id : null,
    model: typeof msg.model === 'string' && msg.model !== '<synthetic>' ? msg.model : null,
    text, tools,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Summary information of one session file (title, summary, counts, dates). */
export async function readClaudeSession(file: string): Promise<ClaudeSessionInfo> {
  const { head, tail, partial, mtime } = await readLines(file);
  const lines = [...head, ...tail];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let firstPrompt: string | null = null;
  let lastAssistant: string | null = null;
  let summaryLine: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  let messages = 0;
  const assistantIds = new Set<string>();
  for (const l of lines) {
    sessionId ??= str(l.sessionId);
    cwd ??= str(l.cwd);
    const ts = str(l.timestamp);
    if (ts) {
      if (!first || ts < first) first = ts;
      if (!last || ts > last) last = ts;
    }
    if (l.type === 'summary' && typeof l.summary === 'string') summaryLine = l.summary;
    else if (l.type === 'user') {
      const t = userText(l);
      if (t) {
        messages++;
        firstPrompt ??= t;
      }
    } else if (l.type === 'assistant') {
      const a = assistantBlocks(l);
      if (!a) continue;
      if (a.model) model = a.model;
      if (a.text) {
        lastAssistant = a.text;
        // One API message is written as several lines (one per content block): count it once.
        if (!a.id) messages++;
        else if (!assistantIds.has(a.id)) {
          assistantIds.add(a.id);
          messages++;
        }
      }
    }
  }
  const fallbackId = path.basename(file, '.jsonl');
  // win32 splits on both / and \ on every OS (Windows paths read on Linux/Docker too).
  const where = cwd ? path.win32.basename(cwd) : null;
  const title = firstPrompt ? clip(firstPrompt, MAX_TITLE) : `Claude Code session${where ? ` in ${where}` : ''}`;
  let summary: string;
  if (summaryLine) summary = clip(summaryLine, MAX_SUMMARY);
  else {
    const asked = firstPrompt ? `Asked: ${clip(firstPrompt, 280)}` : '';
    const outcome = lastAssistant ? `Last answer: ${clip(lastAssistant, 280)}` : '';
    summary = clip([asked, outcome].filter(Boolean).join(' — '), MAX_SUMMARY);
  }
  const fallbackDate = mtime.toISOString();
  return {
    sessionId: sessionId ?? fallbackId,
    cwd, title, summary, model, messageCount: messages,
    startedAt: first ?? fallbackDate,
    lastActivityAt: last ?? fallbackDate,
    partial,
  };
}

/** The last `maxTurns` turns of a session file: user and agent text, tool calls as one-line 'tool' turns. */
export async function readClaudeTranscript(file: string, maxTurns: number): Promise<{ turns: SessionTranscriptTurn[]; truncated: boolean }> {
  const { head, tail, partial } = await readLines(file);
  // For a partial read, the tail holds the latest turns; the head only matters for short files.
  const lines = partial ? tail : head;
  const turns: SessionTranscriptTurn[] = [];
  for (const l of lines) {
    const at = str(l.timestamp);
    if (l.type === 'user') {
      const t = userText(l);
      if (t) turns.push({ role: 'user', text: clipTurn(t), at });
    } else if (l.type === 'assistant') {
      const a = assistantBlocks(l);
      if (!a) continue;
      if (a.text) turns.push({ role: 'agent', text: clipTurn(a.text), at });
      for (const name of a.tools) turns.push({ role: 'tool', text: `Used tool ${name}`, at });
    } else if (l.type === 'summary' && typeof l.summary === 'string') {
      turns.push({ role: 'system', text: clipTurn(`Summary: ${l.summary}`), at: null });
    }
  }
  const truncated = partial || turns.length > maxTurns;
  return { turns: turns.slice(-maxTurns), truncated };
}

function clipTurn(s: string): string {
  const t = s.trim();
  return t.length > MAX_TURN_TEXT ? `${t.slice(0, MAX_TURN_TEXT - 1).trimEnd()}…` : t;
}
