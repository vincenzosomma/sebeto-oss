/**
 * Parser for `claude -p --output-format stream-json --verbose` output (Claude Code 2.1.x).
 *
 * The stream is one JSON object per line. Shapes we rely on (verified against 2.1.319):
 *   {"type":"system","subtype":"init","session_id":"…","tools":[…],"model":"…",…}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"},{"type":"tool_use","name":"Read","input":{…}}],…},"parent_tool_use_id":null,…}
 *   {"type":"user","message":{"content":[{"type":"tool_result",…}]},…}            (ignored)
 *   {"type":"rate_limit_event",…}                                                  (ignored)
 *   {"type":"result","subtype":"success"|"error_…","is_error":false,"total_cost_usd":0.002,
 *    "usage":{"input_tokens":4,"cache_creation_input_tokens":…,"cache_read_input_tokens":…,"output_tokens":127},"result":"…"}
 * Unknown types, unknown fields, blank lines and invalid JSON are ignored (forward compatible).
 */
import type { AgentEvent } from '@sebeto/shared';

const MAX_SUMMARY = 140;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function clip(s: string, max = MAX_SUMMARY): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Claude Code tools that are plumbing, not actions: not shown in "What the agent did". */
export const INTERNAL_TOOLS: ReadonlySet<string> = new Set(['ToolSearch']);

/** Short plain-language description of a tool call, for "What the agent did". */
export function summarizeToolUse(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const filePath = str(i['file_path']) ?? str(i['path']);
  switch (name) {
    case 'Read':
      return clip(`Read the file ${filePath ? baseName(filePath) : ''}`);
    case 'Glob':
      return clip(`Looked for files matching "${str(i['pattern']) ?? ''}"`);
    case 'Grep':
      return clip(`Searched the files for "${str(i['pattern']) ?? ''}"`);
    case 'Write':
    case 'Edit':
      return clip(`Tried to change ${filePath ? baseName(filePath) : 'a file'} directly`);
    case 'Bash':
    case 'PowerShell':
      return clip('Tried to run a command directly');
    case 'WebFetch':
    case 'WebSearch':
      return clip('Tried to use the web directly');
    case 'Task':
    case 'Agent':
      return clip(`Started a helper: ${str(i['description']) ?? 'subtask'}`);
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      if (mcp) {
        const server = mcp[1] === 'sebeto' ? 'Sebeto' : mcp[1];
        return clip(`Used ${server} tool ${mcp[2]}`);
      }
      return clip(`Used the tool ${name}`);
    }
  }
}

/** Plain-language explanation for known error result subtypes. */
function resultErrorMessage(o: Record<string, unknown>): string {
  const subtype = str(o['subtype']) ?? '';
  const errors = Array.isArray(o['errors']) ? o['errors'].filter((e): e is string => typeof e === 'string') : [];
  if (subtype === 'error_max_budget_usd') return 'The cost limit for this run was reached.';
  if (subtype === 'error_max_turns') return 'The agent took too many steps and was stopped.';
  if (subtype === 'error_during_execution') return clip(`The agent stopped because of an error${errors.length ? `: ${errors.join('; ')}` : '.'}`, 400);
  const text = str(o['result']);
  if (text) return clip(text, 400);
  if (errors.length) return clip(errors.join('; '), 400);
  return `Claude Code reported an error${subtype ? ` (${subtype})` : ''}.`;
}

/** Map one parsed stream-json object to zero or more AgentEvents. */
export function mapClaudeMessage(o: unknown): AgentEvent[] {
  if (!isObj(o)) return [];
  const type = str(o['type']);
  const out: AgentEvent[] = [];

  if (type === 'system') {
    const sid = str(o['session_id']);
    if (str(o['subtype']) === 'init' && sid) out.push({ kind: 'session', externalSessionId: sid });
    return out;
  }

  if (type === 'assistant') {
    const msg = o['message'];
    const content = isObj(msg) && Array.isArray(msg['content']) ? msg['content'] : [];
    for (const block of content) {
      if (!isObj(block)) continue;
      const bt = str(block['type']);
      if (bt === 'text') {
        const text = str(block['text'])?.trim();
        if (text) out.push({ kind: 'text', text });
      } else if (bt === 'tool_use') {
        const name = str(block['name']) ?? 'unknown';
        // Claude Code's internal step that loads deferred tools (seen in 2.1.322): not an action for the owner.
        if (!INTERNAL_TOOLS.has(name)) out.push({ kind: 'tool', name, summary: summarizeToolUse(name, block['input']) });
      }
      // thinking / redacted_thinking / other blocks: not shown.
    }
    return out;
  }

  if (type === 'result') {
    const usage = isObj(o['usage']) ? o['usage'] : {};
    const tokensIn = num(usage['input_tokens']) + num(usage['cache_creation_input_tokens']) + num(usage['cache_read_input_tokens']);
    const tokensOut = num(usage['output_tokens']);
    const costUsd = num(o['total_cost_usd']);
    const subtype = str(o['subtype']) ?? '';
    const isError = o['is_error'] === true || subtype.startsWith('error');
    if (isError) out.push({ kind: 'error', message: resultErrorMessage(o) });
    out.push({ kind: 'usage', tokensIn, tokensOut, costUsd });
    out.push({ kind: 'done', costUsd, tokensIn, tokensOut, isError });
    return out;
  }

  return out; // user, rate_limit_event, stream_event, unknown: ignored
}

/**
 * Incremental line parser: feed raw stdout chunks, get AgentEvents. Handles lines split
 * across chunks and CRLF. Call end() when the stream closes to flush a trailing line.
 */
export function createClaudeStreamParser(): {
  push(chunk: string): AgentEvent[];
  end(): AgentEvent[];
  /** Whether a final `result` (→ done) has been seen. */
  readonly sawResult: boolean;
  /** Lines that were not valid JSON (for diagnostics). */
  readonly invalidLines: number;
} {
  let buf = '';
  let sawResult = false;
  let invalidLines = 0;

  const parseLine = (line: string): AgentEvent[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      invalidLines++;
      return [];
    }
    const events = mapClaudeMessage(obj);
    if (events.some((e) => e.kind === 'done')) sawResult = true;
    return events;
  };

  return {
    push(chunk) {
      buf += chunk;
      const out: AgentEvent[] = [];
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        out.push(...parseLine(line));
      }
      return out;
    },
    end() {
      const rest = buf;
      buf = '';
      return parseLine(rest);
    },
    get sawResult() {
      return sawResult;
    },
    get invalidLines() {
      return invalidLines;
    },
  };
}
