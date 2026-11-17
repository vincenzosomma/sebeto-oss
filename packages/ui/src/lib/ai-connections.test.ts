import { describe, expect, it } from 'vitest';
import { aiConnectionRuntimeId, type AiConnection } from '@sebeto/shared';
import { bodyOf, draftOf, hostOf, pricesOf } from './ai-connections';
import { MockApi } from '../api/mock';
import { mockCheckUrl } from '../api/mock-ai-connections';
import { CATALOG } from '../i18n/catalog';

const conn: AiConnection = {
  id: 'c1', runtimeId: aiConnectionRuntimeId('c1'), name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', kind: 'remote', defaultModel: 'openai/gpt-4o-mini',
  hasApiKey: true, allowPrivateHttp: false, prices: { 'openai/gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 } }, replyTimeoutMin: 10, contextWindow: null, createdAt: '', updatedAt: '',
};

describe('AI connections form helpers', () => {
  it('builds a create body: key only when typed, prices only for remote', () => {
    const d = { ...draftOf(null), name: ' LM Studio ', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'qwen/qwen3-4b', prices: [{ model: 'x', inputPerM: '1', outputPerM: '2' }] };
    expect(bodyOf(d, null)).toEqual({ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'local', defaultModel: 'qwen/qwen3-4b', allowPrivateHttp: false, replyTimeoutMin: 30, contextWindow: null, prices: {} });
    expect(bodyOf({ ...d, kind: 'remote', apiKey: ' sk-1 ' }, null)).toMatchObject({ apiKey: 'sk-1', prices: { x: { inputPerM: 1, outputPerM: 2 } } });
  });

  it('an edit keeps the stored key unless a new one is typed or removal is ticked', () => {
    const d = draftOf(conn);
    expect(d.prices).toEqual([{ model: 'openai/gpt-4o-mini', inputPerM: '0.15', outputPerM: '0.6' }]);
    expect(d.apiKey).toBe('');
    expect(bodyOf(d, conn)).not.toHaveProperty('apiKey');
    expect(bodyOf({ ...d, removeKey: true }, conn)).toMatchObject({ apiKey: null });
    expect(bodyOf({ ...d, apiKey: 'sk-new' }, conn)).toMatchObject({ apiKey: 'sk-new' });
  });

  it('reads prices with commas and empty cells as 0; skips rows without a model', () => {
    expect(pricesOf([{ model: 'm', inputPerM: '0,5', outputPerM: '' }, { model: ' ', inputPerM: '1', outputPerM: '1' }])).toEqual({ m: { inputPerM: 0.5, outputPerM: 0 } });
    expect(hostOf('https://openrouter.ai/api/v1')).toBe('openrouter.ai');
  });

  it('the mock API follows the address rules, never returns a key, and lists connections as runtimes', async () => {
    expect(() => mockCheckUrl('http://openrouter.ai/api/v1', 'remote', false)).toThrow(/https/);
    expect(mockCheckUrl('http://127.0.0.1:1234', 'local', false)).toBe('http://127.0.0.1:1234/v1');
    const api = new MockApi({ speed: 0 });
    const c = await api.addAiConnection({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', kind: 'remote', apiKey: 'sk-secret-123' });
    expect(c.hasApiKey).toBe(true);
    expect(JSON.stringify(await api.listAiConnections())).not.toContain('sk-secret-123');
    expect((await api.listRuntimes()).some((r) => r.id === c.runtimeId)).toBe(true);
    expect((await api.testAiConnection(c.id)).ok).toBe(true);
    await api.removeAiConnection(c.id);
    expect((await api.listRuntimes()).some((r) => r.id === c.runtimeId)).toBe(false);
  });

  it('has Italian texts for every AI connections key', () => {
    const keys = Object.keys(CATALOG.en).filter((k) => k.startsWith('aic.'));
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) expect(CATALOG.it[k as keyof typeof CATALOG.it], k).toBeTruthy();
  });
});
