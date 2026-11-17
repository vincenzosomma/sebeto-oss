/** In-memory AI connections for the mock API (v0.7 R): CRUD, a fake "Test connection", runtimes. */
import {
  AI_CONNECTION_LIMITS, aiConnectionRuntimeId, uuidv7,
  type AiConnection, type AiConnectionTestResult, type CreateAiConnectionBody, type Id, type RuntimeInfo, type UpdateAiConnectionBody, type WsEvent,
} from '@sebeto/shared';
import { ApiHttpError } from './types';

const now = () => new Date().toISOString();

/** The same address rules as the core (runtimes/openai-compat.ts), simplified for the demo. */
export function mockCheckUrl(raw: string, kind: AiConnection['kind'], allowPrivateHttp: boolean): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new ApiHttpError(400, 'ai_connection_invalid', 'That is not a valid URL. Example: http://127.0.0.1:1234/v1'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ApiHttpError(400, 'ai_connection_invalid', 'Only http:// and https:// addresses are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (url.protocol === 'http:' && !loopback && !(lan && allowPrivateHttp)) {
    throw new ApiHttpError(400, 'ai_connection_invalid', lan
      ? `${host} is a private network address over plain http://. Tick "Allow plain http on my local network" if you trust this network, or use https://.`
      : 'Use https:// for this address. Plain http:// is allowed only to this computer (127.0.0.1, localhost) or to a private network address you allow.');
  }
  if (kind === 'local' && !loopback && !lan && host.includes('.') && !/\.(local|lan|home|internal)$/.test(host)) {
    throw new ApiHttpError(400, 'ai_connection_invalid', `${host} is not on this computer or your local network. Choose "Remote" for an internet provider: ticket content is sent to it.`);
  }
  const p = url.pathname.replace(/\/+$/, '') || '/v1';
  return `${url.protocol}//${url.host}${p}`;
}

export class MockAiConnections {
  private list_: AiConnection[] = [];

  constructor(private readonly emit: (e: WsEvent) => void, private readonly usedBy: (runtimeId: string) => string[]) {
    const id = uuidv7();
    this.list_.push({
      id, runtimeId: aiConnectionRuntimeId(id), name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', kind: 'local', defaultModel: 'hf.co/fdtn-ai/Foundation-Sec-8B-Reasoning-Q8_0-GGUF',
      hasApiKey: false, allowPrivateHttp: false, prices: {}, replyTimeoutMin: 30, contextWindow: null, createdAt: now(), updatedAt: now(),
    });
  }

  list(): AiConnection[] { return this.list_.map((c) => ({ ...c, prices: { ...c.prices } })); }

  create(body: CreateAiConnectionBody): AiConnection {
    const id = uuidv7();
    const c: AiConnection = {
      id, runtimeId: aiConnectionRuntimeId(id), name: body.name.trim(), kind: body.kind,
      baseUrl: mockCheckUrl(body.baseUrl, body.kind, !!body.allowPrivateHttp), defaultModel: body.defaultModel?.trim() || null,
      hasApiKey: !!body.apiKey, allowPrivateHttp: !!body.allowPrivateHttp, prices: body.prices ?? {},
      replyTimeoutMin: body.replyTimeoutMin ?? AI_CONNECTION_LIMITS.defaultReplyTimeoutMin, contextWindow: body.contextWindow ?? null, createdAt: now(), updatedAt: now(),
    };
    this.list_.push(c);
    this.emit({ type: 'connectors.changed' });
    return { ...c };
  }

  update(id: Id, patch: UpdateAiConnectionBody): AiConnection {
    const c = this.find(id);
    const kind = patch.kind ?? c.kind;
    const allow = patch.allowPrivateHttp ?? c.allowPrivateHttp;
    const next: AiConnection = {
      ...c, kind, allowPrivateHttp: allow,
      name: patch.name?.trim() || c.name,
      baseUrl: mockCheckUrl(patch.baseUrl ?? c.baseUrl, kind, allow),
      defaultModel: patch.defaultModel === undefined ? c.defaultModel : patch.defaultModel?.trim() || null,
      hasApiKey: patch.apiKey === undefined ? c.hasApiKey : !!patch.apiKey,
      prices: patch.prices ?? c.prices,
      replyTimeoutMin: patch.replyTimeoutMin ?? c.replyTimeoutMin,
      contextWindow: patch.contextWindow === undefined ? c.contextWindow : patch.contextWindow,
      updatedAt: now(),
    };
    this.list_ = this.list_.map((x) => (x.id === id ? next : x));
    this.emit({ type: 'connectors.changed' });
    return { ...next };
  }

  remove(id: Id): void {
    const c = this.find(id);
    const users = this.usedBy(c.runtimeId);
    if (users.length) throw new ApiHttpError(409, 'ai_connection_in_use', `"${c.name}" is still used by ${users.join(', ')}. Give them another AI first.`);
    this.list_ = this.list_.filter((x) => x.id !== id);
    this.emit({ type: 'connectors.changed' });
  }

  test(id: Id): AiConnectionTestResult {
    const c = this.find(id);
    if (c.kind === 'remote' && !c.hasApiKey) return { ok: false, models: [], problem: `${c.name} refused the API key (401). Check the key in Connectors → AI connections.`, latencyMs: 240 };
    return { ok: true, models: this.models(c), problem: null, latencyMs: c.kind === 'local' ? 12 : 310 };
  }

  runtimes(): RuntimeInfo[] {
    return this.list_.map((c) => ({
      id: c.runtimeId,
      displayName: c.kind === 'local' ? `${c.name} (local)` : `${c.name} (remote · ${new URL(c.baseUrl).host})`,
      detection: { installed: true, loggedIn: true },
      models: this.models(c),
    }));
  }

  private models(c: AiConnection): string[] {
    const base = c.kind === 'local' ? ['qwen/qwen3-4b', 'google/gemma-3-12b'] : ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'meta-llama/llama-3.3-70b-instruct'];
    return c.defaultModel && !base.includes(c.defaultModel) ? [c.defaultModel, ...base] : base;
  }

  private find(id: Id): AiConnection {
    const c = this.list_.find((x) => x.id === id);
    if (!c) throw new ApiHttpError(404, 'not_found', 'AI connection not found');
    return c;
  }
}
