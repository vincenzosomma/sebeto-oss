import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { RuntimeInfo } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage } from '../lib/format';
import { initialChoice, pickDefaultAgent, runtimeStatus, setupForced, sortRuntimes, type RuntimeChoice, type RuntimeStatus } from '../lib/setup';
import { Connectors } from './Connectors';
import { IntakeChat } from './IntakeChat';
import { BrandMark } from './Logo';

const STEPS = 4;
const CLAUDE_URL = 'https://claude.com/claude-code';
const OLLAMA_URL = 'https://ollama.com';

/**
 * Shows the first-run wizard when the workspace is not set up yet (or with ?setup=1), and again when
 * `runAgain` changes (Settings → Run setup again). Also hosts the dialogs the wizard opens.
 */
export function SetupHost({ runAgain }: { runAgain: number }) {
  const { api } = useStore();
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState<'connectors' | 'intake' | null>(null);

  useEffect(() => {
    let alive = true;
    const forced = typeof window !== 'undefined' && setupForced(window.location.href);
    api.getSettings().then(
      (s) => { if (alive && (forced || !s.setupCompleted)) setOpen(true); },
      () => { if (alive && forced) setOpen(true); },
    );
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (runAgain <= 0) return;
    setOpen(true);
    api.updateSettings({ setupCompleted: false }).catch(() => undefined);
  }, [runAgain, api]);

  const done = useCallback((next?: 'intake') => {
    setOpen(false);
    api.updateSettings({ setupCompleted: true }).catch(() => undefined);
    if (next) setExtra(next);
  }, [api]);

  return (
    <>
      {open && <SetupWizard onDone={done} onConnectors={() => setExtra('connectors')} />}
      {extra === 'connectors' && <Connectors onClose={() => setExtra(null)} />}
      {extra === 'intake' && <IntakeChat onClose={() => setExtra(null)} />}
    </>
  );
}

export function SetupWizard({ onDone, onConnectors }: { onDone: (next?: 'intake') => void; onConnectors: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const aiRef = useRef<{ save: () => Promise<boolean> } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  // Focus management: each step starts at its heading, so screen readers announce it.
  useEffect(() => { headingRef.current?.focus(); }, [step]);

  const next = async () => {
    if (step === 2 && aiRef.current) {
      setSaving(true);
      const ok = await aiRef.current.save();
      setSaving(false);
      if (!ok) return;
    }
    setStep((s) => Math.min(STEPS, s + 1));
  };

  const titles: Record<number, MessageKey> = { 1: 'wz.welcome.title', 2: 'wz.ai.title', 3: 'wz.tools.title', 4: 'wz.try.title' };

  return (
    <dialog
      ref={ref}
      className="wz"
      aria-labelledby="wz-title"
      aria-describedby="wz-progress"
      onCancel={(e) => { e.preventDefault(); onDone(); }}
    >
      <div className="wz__frame">
        <header className="wz__head">
          <BrandMark className="wz__mark" size={32} />
          <div className="wz__progress">
            <span id="wz-progress" className="wz__step">{t('wz.progress', { n: step, total: STEPS })}</span>
            <ol className="wz__bar" aria-hidden="true">
              {Array.from({ length: STEPS }, (_, i) => (
                <li key={i} className={`wz__seg${i < step ? ' wz__seg--on' : ''}`} />
              ))}
            </ol>
          </div>
          <button type="button" className="btn btn--ghost btn--sm wz__skip" onClick={() => onDone()}>{t('wz.skip')}</button>
        </header>

        <section className="wz__body">
          <h2 id="wz-title" className="wz__title" ref={headingRef} tabIndex={-1}>{t(titles[step]!)}</h2>
          {step === 1 && <WelcomeStep />}
          {step === 2 && <AiStep handle={aiRef} />}
          {step === 3 && <ToolsStep onConnectors={onConnectors} />}
          {step === 4 && <TryStep onDone={onDone} />}
        </section>

        <footer className="wz__foot">
          {step > 1 ? (
            <button type="button" className="btn btn--outline" onClick={() => setStep((s) => s - 1)} disabled={saving}>{t('wz.back')}</button>
          ) : <span />}
          {step < STEPS && (
            <span className="wz__next">
              {step === 3 && <button type="button" className="btn btn--ghost" onClick={() => setStep(4)}>{t('wz.tools.skip')}</button>}
              <button type="button" className="btn btn--primary" onClick={() => void next()} disabled={saving}>
                {saving ? t('wz.saving') : step === 1 ? t('wz.start') : t('wz.next')}
              </button>
            </span>
          )}
        </footer>
      </div>
    </dialog>
  );
}

// ------------------------------------------------------------------ steps
function WelcomeStep() {
  const { t } = useI18n();
  return (
    <>
      <p className="wz__lead">{t('wz.welcome.lead')}</p>
      <div className="wz__local">
        <h3 className="wz__local-title">{t('wz.welcome.localTitle')}</h3>
        <ul className="wz__list">
          <li>{t('wz.welcome.local1')}</li>
          <li>{t('wz.welcome.local2')}</li>
          <li>{t('wz.welcome.local3')}</li>
        </ul>
        <p className="small muted">{t('wz.welcome.localNote')}</p>
      </div>
    </>
  );
}

const STATUS_KEY: Record<RuntimeStatus, MessageKey> = { ready: 'wz.ai.ready', signin: 'wz.ai.signin', missing: 'wz.ai.missing' };

function Linked({ text, url }: { text: string; url: string }) {
  // The catalog marks the link position with {link}.
  const [before, after = ''] = text.split('{link}');
  return <>{before}<a href={url} target="_blank" rel="noreferrer noopener">{url.replace(/^https:\/\//, '')}</a>{after}</>;
}

function runtimeHelp(r: RuntimeInfo, status: RuntimeStatus, t: (k: MessageKey) => string): ReactNode {
  if (r.id === 'mock') return t('wz.ai.mockHelp');
  if (r.id === 'claude-cli') {
    if (status === 'ready') return t('wz.ai.claudeReady');
    if (status === 'signin') return t('wz.ai.claudeSignin');
    return <Linked text={t('wz.ai.claudeMissing')} url={CLAUDE_URL} />;
  }
  if (r.id === 'ollama') {
    if (status === 'ready') return r.models.length ? t('wz.ai.ollamaReady') : t('wz.ai.ollamaNoModel');
    return <Linked text={t('wz.ai.ollamaMissing')} url={OLLAMA_URL} />;
  }
  if (status === 'ready') return t('wz.ai.otherReady');
  // The core's problem text is English; add it only when it says more than the chip.
  const problem = r.detection.problem && !/^not installed\.?$/i.test(r.detection.problem.trim()) ? ` ${r.detection.problem}` : '';
  return t(status === 'signin' ? 'wz.ai.otherSignin' : 'wz.ai.otherMissing') + problem;
}

function AiStep({ handle }: { handle: MutableRefObject<{ save: () => Promise<boolean> } | null> }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const [runtimes, setRuntimes] = useState<RuntimeInfo[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<RuntimeChoice | null>(null);
  const agent = pickDefaultAgent(Object.values(state.agents));

  const load = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setRuntimes(sortRuntimes(await api.listRuntimes()));
    } catch (e) {
      setError(errorMessage(e));
      setRuntimes((r) => r ?? []);
    } finally {
      setChecking(false);
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  // Propose a choice once runtimes and the agent are known; keep the owner's pick on "Check again".
  useEffect(() => {
    if (!runtimes) return;
    setChoice((c) => (c && runtimes.some((r) => r.id === c.runtime && runtimeStatus(r) === 'ready') ? c : initialChoice(agent, runtimes)));
  }, [runtimes, agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  handle.current = {
    async save() {
      if (!agent || !choice) return true;
      if (agent.runtime === choice.runtime && (agent.model ?? null) === choice.model) return true;
      try {
        await api.updateAgent(agent.id, { runtime: choice.runtime, model: choice.model });
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      }
    },
  };

  const ready = (runtimes ?? []).filter((r) => runtimeStatus(r) === 'ready');
  const selected = runtimes?.find((r) => r.id === choice?.runtime);

  return (
    <>
      <p className="wz__lead">{t('wz.ai.lead')}</p>
      <div className="wz__row">
        <span className="small muted" role="status">{checking ? t('wz.ai.checking') : ''}</span>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => void load()} disabled={checking}>{t('wz.ai.check')}</button>
      </div>
      {runtimes && (
        <ul className="wz__runtimes">
          {runtimes.map((r) => {
            const status = runtimeStatus(r);
            return (
              <li key={r.id} className={`wz__rt wz__rt--${status}`}>
                <div className="wz__rt-head">
                  <span className="wz__rt-name">{r.id === 'mock' ? t('wz.ai.mockName') : r.displayName}</span>
                  <span className={`wz__chip wz__chip--${status}`}>{t(STATUS_KEY[status])}</span>
                </div>
                <p className="small wz__rt-help">
                  {runtimeHelp(r, status, t)}
                  {status === 'ready' && r.detection.version && r.id !== 'mock' && <span className="muted"> · {t('wz.ai.version', { v: r.detection.version })}</span>}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {runtimes && runtimes.length === 0 && !error && <p className="small muted">{t('wz.ai.none')}</p>}

      {agent && choice && ready.length > 0 && (
        <fieldset className="wz__pick">
          <legend className="wz__pick-legend">{t('wz.ai.pick', { name: agent.name })}</legend>
          <div className="wz__pick-row">
            <label className="field">
              <span className="field__label">{t('wz.ai.runtime')}</span>
              <select className="input" value={choice.runtime} onChange={(e) => setChoice({ runtime: e.target.value, model: null })}>
                {!ready.some((r) => r.id === choice.runtime) && <option value={choice.runtime}>{choice.runtime}</option>}
                {ready.map((r) => <option key={r.id} value={r.id}>{r.id === 'mock' ? t('wz.ai.mockName') : r.displayName}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field__label">{t('wz.ai.model')}</span>
              <select className="input" value={choice.model ?? ''} onChange={(e) => setChoice({ ...choice, model: e.target.value || null })}
                disabled={choice.runtime === 'mock'}>
                <option value="">{t('wz.ai.modelAuto')}</option>
                {(selected?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <p className="small muted">{choice.runtime === 'mock' ? t('wz.ai.pickMock') : t('wz.ai.pickHint')}</p>
        </fieldset>
      )}
      {error && <p className="mail-error" role="alert">{error}</p>}
    </>
  );
}

function ToolsStep({ onConnectors }: { onConnectors: () => void }) {
  const { state } = useStore();
  const { t } = useI18n();
  const mail = state.mail;
  return (
    <>
      <p className="wz__lead">{t('wz.tools.lead')}</p>
      <div className="wz__tool">
        <div>
          <div className="wz__rt-name">Gmail</div>
          <p className="small muted">
            {mail?.connected ? t('wz.tools.gmailOn', { address: mail.address }) : t('wz.tools.gmailOff')}
          </p>
        </div>
        <span className={`wz__chip wz__chip--${mail?.connected ? 'ready' : 'missing'}`}>
          {mail?.connected ? t('wz.tools.connected') : t('wz.tools.notConnected')}
        </span>
      </div>
      <p className="small muted">{t('wz.tools.more')}</p>
      <div>
        <button type="button" className="btn btn--outline" onClick={onConnectors}>{t('wz.tools.open')}</button>
      </div>
    </>
  );
}

function TryStep({ onDone }: { onDone: (next?: 'intake') => void }) {
  const { t } = useI18n();
  const items: Array<[MessageKey, MessageKey]> = [
    ['wz.try.boardTitle', 'wz.try.board'],
    ['wz.try.describeTitle', 'wz.try.describe'],
    ['wz.try.askTitle', 'wz.try.ask'],
  ];
  return (
    <>
      <ol className="wz__tips">
        {items.map(([title, body], i) => (
          <li key={title} className="wz__tip">
            <span className="wz__num" aria-hidden="true">{i + 1}</span>
            <div>
              <h3 className="wz__tip-title">{t(title)}</h3>
              <p className="small">{t(body)}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="wz__finish">
        <button type="button" className="btn btn--tuff" onClick={() => onDone('intake')}>{t('wz.try.first')}</button>
        <button type="button" className="btn btn--outline" onClick={() => onDone()}>{t('wz.try.goBoard')}</button>
      </div>
    </>
  );
}
