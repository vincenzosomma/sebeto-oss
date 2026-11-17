/**
 * v0.7 R: the "AI connections" section of Connectors: OpenAI-compatible endpoints (LM Studio, vLLM,
 * llama.cpp, OpenRouter…). Add, edit, test, remove. The API key goes in, never out; remote
 * connections say clearly that ticket content is sent to that provider.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AI_CONNECTION_LIMITS, type AiConnection, type AiConnectionTestResult, type Id } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage } from '../lib/format';
import { bodyOf, draftOf, hostOf, type AiConnectionDraft } from '../lib/ai-connections';

export function AiConnections() {
  const { state, api } = useStore();
  const { t } = useI18n();
  const [list, setList] = useState<AiConnection[] | null>(null);
  const [editing, setEditing] = useState<AiConnection | 'new' | null>(null);
  const [tests, setTests] = useState<Record<Id, AiConnectionTestResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.listAiConnections().then(setList, (e) => setError(errorMessage(e))), [api]);
  useEffect(() => { void load(); }, [load, state.connectorsVersion]);

  const test = async (c: AiConnection) => {
    setBusy(`t${c.id}`); setError(null);
    try {
      const r = await api.testAiConnection(c.id);
      setTests((x) => ({ ...x, [c.id]: r }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };
  const remove = async (c: AiConnection) => {
    if (!window.confirm(t('aic.removeConfirm', { name: c.name }))) return;
    setBusy(`r${c.id}`); setError(null);
    try { await api.removeAiConnection(c.id); await load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };

  return (
    <section className="aic" aria-labelledby="aic-heading">
      <h3 className="section-label" id="aic-heading">{t('aic.heading')}</h3>
      <p className="small muted">{t('aic.intro')}</p>
      {error && <p className="mail-error" role="alert">{error}</p>}
      {editing ? (
        <AiConnectionForm
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(c) => { setEditing(null); void load(); void test(c); }}
        />
      ) : (
        <>
          {list && list.length === 0 && <p className="trusted__empty">{t('aic.none')}</p>}
          <ul className="cx__installed">
            {(list ?? []).map((c) => {
              const r = tests[c.id];
              const priced = Object.keys(c.prices).length;
              return (
                <li key={c.id} className="cx__row">
                  <div className="cx__main">
                    <strong>{c.name}</strong>
                    <span className="small muted cx__mono">{c.baseUrl}{c.defaultModel ? ` · ${c.defaultModel}` : ''}</span>
                    <span className="small muted">
                      {c.hasApiKey ? t('aic.keyStored') : t('aic.noKey')}
                      {' · '}
                      {c.kind === 'local' ? t('aic.free') : priced ? t('aic.priceSet', { n: priced }) : t('aic.priceUnknown')}
                    </span>
                    {c.kind === 'remote' && <span className="chip chip--warn">{t('aic.sendsTo', { host: hostOf(c.baseUrl) })}</span>}
                    {r && (r.ok
                      ? <span className="small aic__ok" role="status">{t('aic.ok', { n: r.models.length, ms: r.latencyMs })}</span>
                      : <span className="small cx__err" role="status">{t('aic.failed', { problem: r.problem ?? '' })}</span>)}
                  </div>
                  <span className={`cx__status${c.kind === 'local' ? ' cx__status--connected' : ' aic__remote'}`}>{t(c.kind === 'local' ? 'aic.badge.local' : 'aic.badge.remote')}</span>
                  <span className="row cx__actions">
                    <button type="button" className="btn btn--outline btn--sm" disabled={!!busy} onClick={() => void test(c)}>
                      {busy === `t${c.id}` ? t('aic.testing') : t('aic.test')}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => setEditing(c)}>{t('aic.edit')}</button>
                    <button type="button" className="btn btn--ghost btn--sm cx__remove" disabled={!!busy} onClick={() => void remove(c)}>{t('aic.remove')}</button>
                  </span>
                </li>
              );
            })}
          </ul>
          <button type="button" className="btn btn--primary btn--sm aic__add" onClick={() => setEditing('new')}>{t('aic.add')}</button>
        </>
      )}
    </section>
  );
}

function AiConnectionForm({ initial, onCancel, onSaved }: { initial: AiConnection | null; onCancel: () => void; onSaved: (c: AiConnection) => void }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [d, setD] = useState<AiConnectionDraft>(() => draftOf(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AiConnectionDraft>(k: K, v: AiConnectionDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const patchPrice = (i: number, p: Partial<AiConnectionDraft['prices'][number]>) => setD((x) => ({ ...x, prices: x.prices.map((r, j) => (j === i ? { ...r, ...p } : r)) }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = bodyOf(d, initial);
      const c = initial ? await api.updateAiConnection(initial.id, body) : await api.addAiConnection(body as Parameters<typeof api.addAiConnection>[0]);
      onSaved(c);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="mail-form aic__form" onSubmit={(e) => void submit(e)}>
      <h4 className="aic__title">{initial ? t('aic.editTitle', { name: initial.name }) : t('aic.addTitle')}</h4>
      <label className="field">
        <span className="field__label">{t('aic.name')}</span>
        <input className="input" required maxLength={60} value={d.name} placeholder={t('aic.namePlaceholder')} onChange={(e) => set('name', e.target.value)} />
      </label>
      <fieldset className="cx__kind">
        <legend className="field__label">{t('aic.kind')}</legend>
        <label className="check"><input type="radio" name="aic-kind" checked={d.kind === 'local'} onChange={() => set('kind', 'local')} /><span>{t('aic.kind.local')}</span></label>
        <label className="check"><input type="radio" name="aic-kind" checked={d.kind === 'remote'} onChange={() => set('kind', 'remote')} /><span>{t('aic.kind.remote')}</span></label>
      </fieldset>
      <label className="field">
        <span className="field__label">{t('aic.baseUrl')}</span>
        <input className="input cx__mono" required type="url" value={d.baseUrl}
          placeholder={d.kind === 'local' ? 'http://127.0.0.1:1234/v1' : 'https://openrouter.ai/api/v1'} onChange={(e) => set('baseUrl', e.target.value)} />
        <span className="small muted">{t('aic.baseUrlHelp')}</span>
      </label>
      {d.kind === 'remote'
        ? <p className="small cx__warn" role="note">{t('aic.remoteWarn', { host: d.baseUrl ? hostOf(d.baseUrl) : '…' })}</p>
        : <p className="small muted">{t('aic.localNote')}</p>}
      <label className="check"><input type="checkbox" checked={d.allowPrivateHttp} onChange={(e) => set('allowPrivateHttp', e.target.checked)} /><span>{t('aic.allowHttp')}</span></label>
      <label className="field">
        <span className="field__label">{t('aic.apiKey')}</span>
        <input className="input" type="password" autoComplete="off" value={d.apiKey} disabled={d.removeKey} onChange={(e) => set('apiKey', e.target.value)} />
        <span className="small muted">{initial?.hasApiKey ? t('aic.apiKeySet') : t('aic.apiKeyHelp')}</span>
      </label>
      {initial?.hasApiKey && (
        <label className="check"><input type="checkbox" checked={d.removeKey} onChange={(e) => set('removeKey', e.target.checked)} /><span>{t('aic.apiKeyRemove')}</span></label>
      )}
      <label className="field">
        <span className="field__label">{t('aic.defaultModel')}</span>
        <input className="input cx__mono" maxLength={200} value={d.defaultModel} placeholder={d.kind === 'local' ? 'qwen/qwen3-4b' : 'openai/gpt-4o-mini'} onChange={(e) => set('defaultModel', e.target.value)} />
        <span className="small muted">{t('aic.defaultModelHelp')}</span>
      </label>
      <div className="aic__nums">
        <label className="field">
          <span className="field__label">{t('aic.timeout')}</span>
          <input className="input" type="number" min={AI_CONNECTION_LIMITS.minReplyTimeoutMin} max={AI_CONNECTION_LIMITS.maxReplyTimeoutMin} value={d.replyTimeoutMin} onChange={(e) => set('replyTimeoutMin', e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">{t('aic.contextWindow')}</span>
          <input className="input" type="number" min={2048} step={1024} value={d.contextWindow} onChange={(e) => set('contextWindow', e.target.value)} />
          <span className="small muted">{t('aic.contextWindowHelp')}</span>
        </label>
      </div>
      {d.kind === 'remote' && (
        <div className="field">
          <span className="field__label">{t('aic.prices')}</span>
          <span className="small muted">{t('aic.pricesHelp')}</span>
          {d.prices.length > 0 && (
            <div className="aic__price aic__price--head small muted" aria-hidden="true">
              <span>{t('aic.priceModel')}</span><span>{t('aic.priceIn')}</span><span>{t('aic.priceOut')}</span><span />
            </div>
          )}
          {d.prices.map((p, i) => (
            <div key={i} className="aic__price">
              <input className="input cx__mono" value={p.model} aria-label={t('aic.priceModel')} onChange={(e) => patchPrice(i, { model: e.target.value })} />
              <input className="input" type="number" min={0} step="any" value={p.inputPerM} aria-label={t('aic.priceIn')} onChange={(e) => patchPrice(i, { inputPerM: e.target.value })} />
              <input className="input" type="number" min={0} step="any" value={p.outputPerM} aria-label={t('aic.priceOut')} onChange={(e) => patchPrice(i, { outputPerM: e.target.value })} />
              <button type="button" className="icon-btn" aria-label={t('aic.removePrice')} onClick={() => setD((x) => ({ ...x, prices: x.prices.filter((_, j) => j !== i) }))}>×</button>
            </div>
          ))}
          <button type="button" className="btn btn--ghost btn--sm cx__addsetting"
            onClick={() => setD((x) => ({ ...x, prices: [...x.prices, { model: x.prices.length ? '' : x.defaultModel, inputPerM: '', outputPerM: '' }] }))}>
            {t('aic.addPrice')}
          </button>
        </div>
      )}
      {error && <p className="mail-error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? t('aic.saving') : t('aic.save')}</button>
        <button type="button" className="btn btn--outline" disabled={busy} onClick={onCancel}>{t('aic.cancel')}</button>
      </div>
    </form>
  );
}
