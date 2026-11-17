import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CatalogEntry, ConnectorInfo, ConnectorSetting, ConnectorsResponse, ToolLevel } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage } from '../lib/format';
import { Dialog } from './Dialog';
import { MailSettings } from './MailSettings';
import { SignInConnector } from './SignInConnector';
import { AiConnections } from './AiConnections';
import type { OAuthProviderId } from '@sebeto/shared';

/** Split a command line into program + arguments, honouring "double" and 'single' quotes. Exported for tests. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const LEVELS: ToolLevel[] = ['read', 'change', 'production', 'off'];

type View = { kind: 'list' } | { kind: 'add'; entry: CatalogEntry } | { kind: 'review'; id: string };

export function Connectors({ onClose }: { onClose: () => void }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const [data, setData] = useState<ConnectorsResponse | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [mailOpen, setMailOpen] = useState(false);
  const [signIn, setSignIn] = useState<OAuthProviderId | null>(null);
  // The mailbox row opens the screen of the provider in use.
  const openMailbox = () => {
    const p = state.mail?.connected ? state.mail.provider : null;
    if (p === 'microsoft' || p === 'google') setSignIn(p); else setMailOpen(true);
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.listConnectors().then(setData, (e) => setError(errorMessage(e))), [api]);
  useEffect(() => { void load(); }, [load, state.connectorsVersion]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };

  const title = view.kind === 'add' ? t('conn.addTitle', { name: view.entry.name })
    : view.kind === 'review' ? t('conn.reviewTitle', { name: data?.installed.find((c) => c.id === view.id)?.name ?? '' })
    : t('conn.heading');

  return (
    <Dialog title={title} onClose={onClose} wide>
      {error && <p className="mail-error" role="alert">{error}</p>}
      {!data ? <p className="small muted" role="status">{t('panel.loading')}</p>
        : view.kind === 'add' ? (
          <AddConnector entry={view.entry} onCancel={() => setView({ kind: 'list' })}
            onAdded={(c) => { void load(); setView({ kind: 'review', id: c.id }); }} />
        ) : view.kind === 'review' && data.installed.find((c) => c.id === view.id) ? (
          <ToolReview connector={data.installed.find((c) => c.id === view.id)!} onDone={() => { void load(); setView({ kind: 'list' }); }} />
        ) : (
          <div className="cx">
            <p className="small muted">{t('conn.intro')}</p>
            <h3 className="section-label">{t('conn.installed')}</h3>
            <ul className="cx__installed">
              <li className="cx__row">
                <div className="cx__main">
                  <strong>{t('conn.mailbox')}{state.mail?.connected ? ` · ${t(`conn.provider.${state.mail.provider}` as MessageKey)}` : ''}</strong>
                  <span className="small muted">{state.mail?.connected ? state.mail.address : t('conn.notConnected')}</span>
                </div>
                <span className={`cx__status cx__status--${state.mail?.connected ? 'connected' : 'disabled'}`}>{t(state.mail?.connected ? 'conn.status.connected' : 'conn.status.off')}</span>
                <button type="button" className="btn btn--outline btn--sm" onClick={openMailbox}>{t('conn.manage')}</button>
              </li>
              {data.installed.map((c) => {
                const pending = c.tools.filter((x) => !x.reviewed).length;
                const on = c.tools.filter((x) => x.reviewed && x.level !== 'off').length;
                return (
                  <li key={c.id} className="cx__row">
                    <div className="cx__main">
                      <strong>{c.name}</strong>
                      <span className="small muted">
                        {t('conn.toolsOn', { on, total: c.tools.length })}
                        {c.allowedAgents ? ` · ${t('conn.someAgents', { n: c.allowedAgents.length })}` : ''}
                      </span>
                      {pending > 0 && <span className="chip chip--warn">{t('conn.needsReview', { n: pending })}</span>}
                      {c.error && <span className="small cx__err">{c.error}</span>}
                    </div>
                    <span className={`cx__status cx__status--${c.status}`}>{t(`conn.status.${c.status === 'disabled' ? 'off' : c.status}` as MessageKey)}</span>
                    <span className="row cx__actions">
                      <button type="button" className="btn btn--outline btn--sm" onClick={() => setView({ kind: 'review', id: c.id })}>{t('conn.review')}</button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void act(c.id, () => api.refreshConnector(c.id))}>
                        {busy === c.id ? t('conn.starting') : t('conn.refresh')}
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void act('t' + c.id, () => api.updateConnector(c.id, { enabled: !c.enabled }))}>
                        {t(c.enabled ? 'conn.turnOff' : 'conn.turnOn')}
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm cx__remove" disabled={!!busy} onClick={() => void act('r' + c.id, () => api.removeConnector(c.id))}>
                        {t('conn.remove')}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>

            <AiConnections />

            <h3 className="section-label">{t('conn.catalog')}</h3>
            <ul className="cx__catalog">
              {data.catalog.map((e) => (
                <li key={e.id} className={`cx__card${e.availability === 'planned' ? ' cx__card--planned' : ''}`}>
                  <div className="cx__cardhead">
                    <strong>{e.name}</strong>
                    <span className="small muted">{e.category}</span>
                  </div>
                  <p className="small">{e.description}</p>
                  <p className="small muted">{e.capabilities}</p>
                  {e.availability === 'planned' ? <span className="chip">{t('conn.planned')}</span>
                    : e.availability === 'builtin' && (e.id === 'microsoft' || e.id === 'google')
                      ? <button type="button" className="btn btn--primary btn--sm" onClick={() => setSignIn(e.id as OAuthProviderId)}>{t(state.mail?.connected && state.mail.provider === e.id ? 'conn.manage' : 'conn.signIn')}</button>
                    : e.availability === 'builtin' ? <button type="button" className="btn btn--outline btn--sm" onClick={() => setMailOpen(true)}>{t(state.mail?.connected && state.mail.provider === 'gmail' ? 'conn.manage' : 'conn.connect')}</button>
                    : <button type="button" className="btn btn--primary btn--sm" onClick={() => setView({ kind: 'add', entry: e })}>{t(e.availability === 'custom' ? 'conn.addCustom' : 'conn.connect')}</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
      {mailOpen && <MailSettings onClose={() => setMailOpen(false)} />}
      {signIn && <SignInConnector provider={signIn} onClose={() => setSignIn(null)} />}
    </Dialog>
  );
}

function AddConnector({ entry, onCancel, onAdded }: { entry: CatalogEntry; onCancel: () => void; onAdded: (c: ConnectorInfo) => void }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const custom = entry.availability === 'custom';
  const [name, setName] = useState(custom ? '' : entry.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<'stdio' | 'http'>('stdio');
  const [commandLine, setCommandLine] = useState('');
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<ConnectorSetting[]>([]);
  const [allAgents, setAllAgents] = useState(true);
  const [agents, setAgents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentList = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const parts = splitCommandLine(commandLine);
      const c = await api.addConnector({
        name, catalogId: entry.id,
        ...(custom ? {
          transport: kind === 'stdio' ? { type: 'stdio', command: parts[0] ?? '', args: parts.slice(1) } : { type: 'http', url: url.trim() },
          settings: settings.filter((s) => s.name.trim()),
        } : { values }),
        allowedAgents: allAgents ? null : agents,
      });
      onAdded(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const patchSetting = (i: number, p: Partial<ConnectorSetting>) => setSettings((ss) => ss.map((s, j) => (j === i ? { ...s, ...p } : s)));

  return (
    <form className="mail-form" onSubmit={(e) => void submit(e)}>
      <p className="small muted">{entry.capabilities}</p>
      <label className="field">
        <span className="field__label">{t('conn.name')}</span>
        <input className="input" required maxLength={60} value={name} placeholder={t('conn.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      </label>
      {entry.fields.map((f) => (
        <label key={f.key} className="field">
          <span className="field__label">{f.label}</span>
          <input className="input" required={!f.optional} type={f.kind === 'secret' ? 'password' : f.kind === 'url' ? 'url' : 'text'} autoComplete={f.kind === 'secret' ? 'off' : undefined} placeholder={f.placeholder}
            value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
          {f.help && <span className="small muted">{f.help}</span>}
        </label>
      ))}
      {custom && (
        <>
          <fieldset className="cx__kind">
            <legend className="field__label">{t('conn.how')}</legend>
            <label className="check"><input type="radio" checked={kind === 'stdio'} onChange={() => setKind('stdio')} /><span>{t('conn.byCommand')}</span></label>
            <label className="check"><input type="radio" checked={kind === 'http'} onChange={() => setKind('http')} /><span>{t('conn.byUrl')}</span></label>
          </fieldset>
          {kind === 'stdio' ? (
            <label className="field">
              <span className="field__label">{t('conn.command')}</span>
              <input className="input cx__mono" required value={commandLine} placeholder="npx -y @company/mcp-server@1.2.3 --read-only" onChange={(e) => setCommandLine(e.target.value)} />
              <span className="small cx__warn">{t('conn.commandWarn')}</span>
            </label>
          ) : (
            <label className="field">
              <span className="field__label">URL</span>
              <input className="input cx__mono" required type="url" value={url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
            </label>
          )}
          <div className="field">
            <span className="field__label">{t(kind === 'stdio' ? 'conn.envVars' : 'conn.headers')}</span>
            {settings.map((s, i) => (
              <div key={i} className="cx__setting">
                <input className="input cx__mono" placeholder={kind === 'stdio' ? 'API_TOKEN' : 'Authorization'} value={s.name} onChange={(e) => patchSetting(i, { name: e.target.value })} aria-label={t('conn.settingName')} />
                <input className="input" type={s.secret ? 'password' : 'text'} value={s.value ?? ''} onChange={(e) => patchSetting(i, { value: e.target.value })} aria-label={t('conn.settingValue')} />
                <label className="check"><input type="checkbox" checked={s.secret} onChange={(e) => patchSetting(i, { secret: e.target.checked })} /><span>{t('conn.secret')}</span></label>
                <button type="button" className="icon-btn" aria-label={t('conn.remove')} onClick={() => setSettings((ss) => ss.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button type="button" className="btn btn--ghost btn--sm cx__addsetting" onClick={() => setSettings((ss) => [...ss, { name: '', value: '', secret: true }])}>{t('conn.addSetting')}</button>
            <span className="small muted">{t('conn.secretHint')}</span>
          </div>
        </>
      )}
      <fieldset className="cx__agents">
        <legend className="field__label">{t('conn.whichAgents')}</legend>
        <label className="check"><input type="checkbox" checked={allAgents} onChange={(e) => setAllAgents(e.target.checked)} /><span>{t('conn.allAgents')}</span></label>
        {!allAgents && agentList.map((a) => (
          <label key={a.id} className="check">
            <input type="checkbox" checked={agents.includes(a.id)} onChange={(e) => setAgents((xs) => (e.target.checked ? [...xs, a.id] : xs.filter((x) => x !== a.id)))} />
            <span>{a.name}</span>
          </label>
        ))}
      </fieldset>
      {error && <p className="mail-error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? t('conn.starting') : t('conn.startAndList')}</button>
        <button type="button" className="btn btn--outline" disabled={busy} onClick={onCancel}>{t('conn.back')}</button>
      </div>
      {busy && <p className="small muted" role="status">{t('conn.firstStart')}</p>}
    </form>
  );
}

function ToolReview({ connector, onDone }: { connector: ConnectorInfo; onDone: () => void }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [levels, setLevels] = useState<Record<string, ToolLevel>>(() => Object.fromEntries(connector.tools.map((x) => [x.name, x.level])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api.updateConnector(connector.id, { tools: connector.tools.map((x) => ({ name: x.name, level: levels[x.name] ?? 'off' })) });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="cx">
      <p className="small muted">{t('conn.reviewIntro')}</p>
      <ul className="cx__levels small">
        {LEVELS.map((l) => <li key={l}><strong>{t(`conn.level.${l}` as MessageKey)}</strong>: {t(`conn.levelHelp.${l}` as MessageKey)}</li>)}
      </ul>
      {connector.tools.length === 0 && <p className="trusted__empty">{t('conn.noTools')}</p>}
      <ul className="cx__tools">
        {connector.tools.map((x) => (
          <li key={x.name} className="cx__tool">
            <div className="cx__main">
              <code className="trusted__cmd">{x.name}</code>
              {!x.reviewed && <span className="chip chip--warn">{t('conn.newOrChanged')}</span>}
              <span className="small">{x.description || '—'}</span>
              <span className="small muted">{t('conn.suggested', { level: t(`conn.level.${x.suggested}` as MessageKey) })}</span>
            </div>
            <select className="input input--sm" value={levels[x.name] ?? 'off'} aria-label={t('conn.levelFor', { name: x.name })}
              onChange={(e) => setLevels((ls) => ({ ...ls, [x.name]: e.target.value as ToolLevel }))}>
              {LEVELS.map((l) => <option key={l} value={l}>{t(`conn.level.${l}` as MessageKey)}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {error && <p className="mail-error" role="alert">{error}</p>}
      <div className="row">
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>{t('conn.saveReview')}</button>
        <button type="button" className="btn btn--outline" disabled={busy} onClick={onDone}>{t('conn.back')}</button>
      </div>
    </div>
  );
}
