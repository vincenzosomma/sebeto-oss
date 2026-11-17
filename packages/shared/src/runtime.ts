/**
 * Runtime adapter contract. Every agent runtime (mock, claude-cli, later codex, gemini, ollama, claude-sdk)
 * implements this. See docs/09 Runtimes & Sessions.md.
 */
import type { PermissionKey, PermissionLevel, RuntimeId } from './types.js';

export interface RuntimeDetection {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  problem?: string; // plain-language reason when not usable
}

export interface RuntimeCapabilities {
  tools: boolean; // can call MCP tools
  resume: boolean; // supports resuming an external session
  costReport: boolean; // reports cost/tokens
  /** Model context size in tokens, when known (used to decide compaction). */
  contextWindow?: number;
  /** True when the runtime compacts its own context (e.g. Claude Code); Sebeto then leaves it alone. */
  nativeCompaction?: boolean;
}

/** Everything an adapter needs to execute one run. */
export interface TicketRun {
  ticketId: string;
  runId: string;
  /** Existing external session to resume (undefined = start new). */
  externalSessionId?: string;
  /** Sebeto-generated id the adapter should use for a NEW external session when the runtime supports it. */
  newExternalSessionId?: string;
  cwd: string; // ticket sandbox folder
  model?: string | null;
  systemPrompt: string; // role + job + skills
  prompt: string; // user message, goal, or check-in instruction
  permissions: Record<PermissionKey, PermissionLevel>;
  budgetUsd: number; // remaining cap for this run
  /** MCP server config the runtime must connect to for Sebeto tools (per-session token embedded). */
  mcp?: { url: string; token: string };
  /** Claude Code only: the owner's Claude connectors this agent may use, gated through Sebeto's approve_tool. */
  claudeConnectors?: string[];
  signal: AbortSignal;
}

export type AgentEvent =
  | { kind: 'session'; externalSessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'ask'; question: string }
  | { kind: 'status'; status: 'in_progress' | 'needs_you' | 'blocked' | 'done'; note?: string }
  | { kind: 'error'; message: string }
  | { kind: 'usage'; tokensIn: number; tokensOut: number; costUsd?: number; /** Size of the largest prompt the model saw in this run. */ contextTokens?: number }
  | { kind: 'done'; costUsd?: number; tokensIn?: number; tokensOut?: number; isError?: boolean };

export interface RuntimeAdapter {
  id: RuntimeId;
  displayName: string;
  capabilities: RuntimeCapabilities;
  detect(): Promise<RuntimeDetection>;
  models(): Promise<string[]>;
  /** Execute one run (start or resume). Yields events until the run ends. Must honour run.signal. */
  run(run: TicketRun): AsyncIterable<AgentEvent>;
}
