/**
 * Helpers shared by the MCP servers that ship inside Sebeto (Atlassian, Slack).
 *
 * These servers run in-process and are reached through the McpHub like any other connector, so
 * tool review, the permission gate, the audit log and untrusted-content tagging all still apply.
 * They only ever see their own settings (passed in `env`), never other Sebeto secrets.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type FetchLike = typeof fetch;

/** A friendly error whose message is safe to show to the agent (no tokens, no stack). */
export class BuiltinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuiltinError';
  }
}

export const ok = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
export const fail = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

/** Runs a tool body and turns any error into an isError result with a short message. */
export async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof BuiltinError) return fail(err.message);
    const e = err as { name?: string; message?: string };
    if (e.name === 'AbortError') return fail('The request was cancelled or took too long.');
    return fail(`The request failed: ${(e.message ?? String(err)).split('\n')[0]!.slice(0, 300)}`);
  }
}

/** Pretty JSON for tool output. */
export const json = (v: unknown): string => JSON.stringify(v, null, 2);

export function clip(s: string | null | undefined, max: number): string {
  const t = s ?? '';
  return t.length > max ? `${t.slice(0, max)}… [truncated, ${t.length - max} more characters]` : t;
}
