/** Pure helpers for the AI connections form (v0.7 R). The core validates everything again. */
import { AI_CONNECTION_LIMITS, type AiConnection, type AiModelPrice, type CreateAiConnectionBody, type UpdateAiConnectionBody } from '@sebeto/shared';

export interface PriceRow { model: string; inputPerM: string; outputPerM: string }

export interface AiConnectionDraft {
  name: string;
  baseUrl: string;
  kind: AiConnection['kind'];
  /** Empty = keep the stored key (edit) / no key (new). */
  apiKey: string;
  removeKey: boolean;
  defaultModel: string;
  allowPrivateHttp: boolean;
  replyTimeoutMin: string;
  contextWindow: string;
  prices: PriceRow[];
}

export function draftOf(c: AiConnection | null): AiConnectionDraft {
  return {
    name: c?.name ?? '', baseUrl: c?.baseUrl ?? '', kind: c?.kind ?? 'local', apiKey: '', removeKey: false,
    defaultModel: c?.defaultModel ?? '', allowPrivateHttp: c?.allowPrivateHttp ?? false,
    replyTimeoutMin: String(c?.replyTimeoutMin ?? AI_CONNECTION_LIMITS.defaultReplyTimeoutMin),
    contextWindow: c?.contextWindow ? String(c.contextWindow) : '',
    prices: Object.entries(c?.prices ?? {}).map(([model, p]) => ({ model, inputPerM: String(p.inputPerM), outputPerM: String(p.outputPerM) })),
  };
}

/** Rows with a model name become prices; empty numbers count as 0. */
export function pricesOf(rows: PriceRow[]): Record<string, AiModelPrice> {
  const out: Record<string, AiModelPrice> = {};
  for (const r of rows) {
    const model = r.model.trim();
    if (!model) continue;
    const n = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(',', '.')));
    out[model] = { inputPerM: n(r.inputPerM), outputPerM: n(r.outputPerM) };
  }
  return out;
}

/** The body for POST (initial = null) or PATCH. The key is sent only when typed (or removed). */
export function bodyOf(d: AiConnectionDraft, initial: AiConnection | null): CreateAiConnectionBody | UpdateAiConnectionBody {
  const timeout = Number.parseInt(d.replyTimeoutMin, 10);
  const ctx = d.contextWindow.trim() ? Number.parseInt(d.contextWindow, 10) : null;
  const body: CreateAiConnectionBody = {
    name: d.name.trim(), baseUrl: d.baseUrl.trim(), kind: d.kind,
    defaultModel: d.defaultModel.trim() || null,
    allowPrivateHttp: d.allowPrivateHttp,
    replyTimeoutMin: Number.isFinite(timeout) ? timeout : AI_CONNECTION_LIMITS.defaultReplyTimeoutMin,
    contextWindow: ctx,
    prices: d.kind === 'remote' ? pricesOf(d.prices) : {},
  };
  if (d.apiKey.trim()) body.apiKey = d.apiKey.trim();
  if (!initial) return body;
  const patch: UpdateAiConnectionBody = { ...body };
  if (!d.apiKey.trim()) delete patch.apiKey;
  if (d.removeKey && !d.apiKey.trim()) patch.apiKey = null;
  return patch;
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
