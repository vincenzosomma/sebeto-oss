/**
 * v0.7 R: OpenAI-compatible AI connections (LM Studio, vLLM, llama.cpp server, OpenRouter, any
 * `/v1/chat/completions` endpoint with tool calling). docs/31 v0.7 Plan.md §R.
 *
 * Each connection the owner adds becomes its own runtime, id `openai:<connectionId>`, so agents,
 * tickets and teams store it like any other runtime string and the v0.4 F team lock compares it
 * exactly: a team locked to one connection cannot run on another connection, nor on Ollama/Claude.
 *
 * The API key lives in the secrets store only: it is never returned by the API (`hasApiKey` tells
 * whether one is set), never written to the settings file, the DB, the logs or the security log.
 *
 * API (under /api/v1):
 *   GET    /ai-connections                       → AiConnection[]
 *   POST   /ai-connections       CreateAiConnectionBody → AiConnection (201)
 *   PATCH  /ai-connections/:id   UpdateAiConnectionBody → AiConnection
 *   DELETE /ai-connections/:id                   → 204 (409 ai_connection_in_use while an agent or team uses it)
 *   POST   /ai-connections/:id/test              → AiConnectionTestResult
 * WebSocket: { type: 'connectors.changed' } after every change (the runtime list changes too).
 */
import type { Id, IsoDate, RuntimeId } from './types.js';

/** 'local' = on this computer or the LAN (cost 0); 'remote' = a provider on the internet (ticket content leaves the computer). */
export type AiConnectionKind = 'local' | 'remote';
export const AI_CONNECTION_KINDS: readonly AiConnectionKind[] = ['local', 'remote'] as const;

/** Runtime ids of AI connections: `openai:<connectionId>`. */
export const OPENAI_RUNTIME_PREFIX = 'openai:';
/** The name in SEBETO_RUNTIMES that enables AI connections. */
export const OPENAI_RUNTIME_FAMILY = 'openai';

export const aiConnectionRuntimeId = (connectionId: Id): RuntimeId => `${OPENAI_RUNTIME_PREFIX}${connectionId}`;
/** The connection id of an `openai:<id>` runtime, else null. */
export function aiConnectionIdOf(runtime: RuntimeId | null | undefined): Id | null {
  return runtime && runtime.startsWith(OPENAI_RUNTIME_PREFIX) && runtime.length > OPENAI_RUNTIME_PREFIX.length
    ? runtime.slice(OPENAI_RUNTIME_PREFIX.length) : null;
}

/** Price the owner sets for a remote model, in US dollars per 1 million tokens. */
export interface AiModelPrice { inputPerM: number; outputPerM: number }

export interface AiConnection {
  id: Id;
  /** `openai:<id>`: what agents, tickets and teams store as their runtime. */
  runtimeId: RuntimeId;
  name: string;
  /** Base URL including the version path, e.g. http://127.0.0.1:1234/v1 or https://openrouter.ai/api/v1. */
  baseUrl: string;
  kind: AiConnectionKind;
  defaultModel: string | null;
  /** True when an API key is stored (the key itself is never returned). */
  hasApiKey: boolean;
  /** Allow plain http:// to a private LAN address (10.x, 192.168.x…). Loopback never needs it. */
  allowPrivateHttp: boolean;
  /** Remote only: $ per 1M tokens by model. A model without a price costs "unknown" (counted as $0) unless the provider reports a cost. */
  prices: Record<string, AiModelPrice>;
  /** Longest wait for one model reply, in minutes (1–240). */
  replyTimeoutMin: number;
  /** Model context size in tokens when known (enables Sebeto's context compaction), else null. */
  contextWindow: number | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface CreateAiConnectionBody {
  name: string;
  baseUrl: string;
  kind: AiConnectionKind;
  /** Stored in the secrets store; never returned. */
  apiKey?: string;
  defaultModel?: string | null;
  allowPrivateHttp?: boolean;
  prices?: Record<string, AiModelPrice>;
  replyTimeoutMin?: number;
  contextWindow?: number | null;
}

export interface UpdateAiConnectionBody {
  name?: string;
  baseUrl?: string;
  kind?: AiConnectionKind;
  /** A new key replaces the stored one; null removes it; omitted keeps it. */
  apiKey?: string | null;
  defaultModel?: string | null;
  allowPrivateHttp?: boolean;
  prices?: Record<string, AiModelPrice>;
  replyTimeoutMin?: number;
  contextWindow?: number | null;
}

export interface AiConnectionTestResult {
  ok: boolean;
  /** Models from GET <baseUrl>/models (empty when the endpoint has no model list). */
  models: string[];
  /** Plain-language reason when not ok (never contains the key). */
  problem: string | null;
  latencyMs: number;
}

/** Defaults and limits shared by the core and the UI. */
export const AI_CONNECTION_LIMITS = {
  maxConnections: 20,
  defaultReplyTimeoutMin: 30,
  minReplyTimeoutMin: 1,
  maxReplyTimeoutMin: 240,
  maxPrices: 100,
  /** $ per 1M tokens: anything above is surely a typo. */
  maxPricePerM: 1000,
} as const;

/** Error codes (409) of the AI-connections API. */
export const AI_CONNECTION_ERRORS = { inUse: 'ai_connection_in_use' } as const;
