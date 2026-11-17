/**
 * Settings → Triggers (v0.4 §D): tickets that open themselves from an alert (webhook), an email
 * (mail rule) or a schedule. The webhook secret is shown once, right after create / "New secret".
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  SLACK_VIA_CLAUDE, nextRuns, parseCron,
  type ConnectorInfo, type Id, type TicketBlueprint, type Trigger, type TriggerConfig, type TriggerFire, type TriggerKind, type TriggerTestResult, type WebhookPreset,
} from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage, formatRelative } from '../lib/format';
import {
  PRESETS, cronToSchedule, curlExample, hookUrl, powershellExample, presetLabel, scheduleToCron, type FriendlySchedule, type ScheduleMode,
} from '../lib/triggers';
import { Dialog } from './Dialog';

const KIND_ICON: Record<TriggerKind, string> = { webhook: '⚡', mail: '✉', schedule: '⏰', slack: '#', jira: '◆' };
const KINDS: TriggerKind[] = ['webhook', 'mail', 'slack', 'jira', 'schedule'];

function origin(): string {
  return typeof window !== 'undefined' && window.location.origin.startsWith('http') ? window.location.origin : 'http://127.0.0.1:7600';
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch { /* clipboard blocked: the text is selectable */ }
  };
  return <button type="button" className="btn btn--outline btn--sm" onClick={() => void copy()}>{done ? t('trg.copied') : t('trg.copy')}</button>;
}

function CodeLine({ label, text }: { label: string; text: string }) {
  return (
    <div className="trg-code">
      <div className="trg-code__head"><span className="small muted">{label}</span><CopyButton text={text} /></div>
      <code className="trg-code__text">{text}</code>
    </div>
  );
}

/** URL, secret (once) and call examples. */
function HookAccess({ trigger, secret, onRotate }: { trigger: Trigger; secret: string | null; onRotate?: () => void }) {
  const { t } = useI18n();
  const url = hookUrl(origin(), trigger.hookPath);
  const shown = secret ?? '<your secret>';
  return (
    <section className="trg-access" aria-label={t('trg.url')}>
      <CodeLine label={t('trg.url')} text={url} />
      {secret ? (
        <>
          <p className="trg-once" role="alert">{t('trg.secretOnce')}</p>
          <CodeLine label={t('trg.secret')} text={secret} />
        </>
      ) : (
        <p className="small muted">{t('trg.secretHidden')}</p>
      )}
      {onRotate && <button type="button" className="btn btn--outline btn--sm" onClick={onRotate}>{t('trg.rotate')}</button>}
      <details open={!!secret}>
        <summary className="small">{t('trg.examples')}</summary>
        <CodeLine label={t('trg.exampleCurl')} text={curlExample(url, shown)} />
        <CodeLine label={t('trg.examplePs')} text={powershellExample(url, shown)} />
      </details>
      <p className="small muted">{t('trg.reach')}</p>
    </section>
  );
}

function describe(tr: Trigger): string {
  const c = tr.config;
  if (c.kind === 'webhook') return presetLabel(c.preset);
  if (c.kind === 'mail') return [c.from, c.subjectContains, c.folder].filter(Boolean).join(' · ');
  if (c.kind === 'jira') return c.jql;
  if (c.kind === 'slack') return [c.channel.startsWith('#') || /^[CG][A-Z0-9]+$/.test(c.channel) ? c.channel : `#${c.channel}`, c.fromContains, c.textContains].filter(Boolean).join(' · ');
  return c.cron;
}

// ------------------------------------------------------------------ editor

interface Draft {
  name: string;
  kind: TriggerKind;
  preset: WebhookPreset;
  dedupeField: string;
  ignoreResolved: boolean;
  dedupeWindowMinutes: number;
  from: string;
  subjectContains: string;
  folder: string;
  pollMinutes: number;
  schedule: FriendlySchedule;
  cron: string;
  slackConnectorId: string;
  slackChannel: string;
  slackFrom: string;
  slackText: string;
  slackBots: boolean;
  slackWait: boolean;
  slackPoll: number;
  /** Kept as they are (set through the API): DM user and repeat grouping. */
  slackNotify: string;
  slackDedupe: string;
  slackWorkspaceUrl: string;
  jiraConnectorId: string;
  jql: string;
  jiraPoll: number;
  jiraSite: string;
  blueprint: TicketBlueprint;
  tagsText: string;
  costText: string;
}

const DEFAULT_BLUEPRINT: Record<TriggerKind, Pick<TicketBlueprint, 'title' | 'goal'>> = {
  webhook: { title: 'Alert: {{title}}', goal: 'An alert came in: {{title}} ({{severity}}) on {{host}}.\nFind out what is wrong, suggest a fix and ask me before changing anything.' },
  mail: { title: 'Email: {{subject}}', goal: 'An email from {{from}} arrived: "{{subject}}".\nRead it, tell me what it needs and prepare the next steps.' },
  jira: { title: '{{issue}}: {{title}}', goal: 'New Jira ticket {{issue}} from {{from}}: "{{title}}".\nWork out what is being asked, gather what is needed and propose the next steps. Ask me before commenting on the ticket or changing anything.\nTicket: {{issue_url}}' },
  slack: { title: '{{title}}', goal: '{{from}} posted in {{channel}}: "{{title}}".\nWork out what is being asked, gather what is needed and propose the next steps. Ask me before replying in Slack or changing anything.\nMessage: {{link}}' },
  schedule: { title: 'Weekly check ({{date}})', goal: 'List the certificates that expire in the next 30 days and who owns them.' },
};

function draftFrom(tr: Trigger | null, kind: TriggerKind = 'webhook'): Draft {
  const k = tr?.kind ?? kind;
  const c = tr?.config;
  const bp: TicketBlueprint = tr?.blueprint ?? { ...DEFAULT_BLUEPRINT[k], teamId: null, agentId: null, projectId: null, tags: [], costCapUsd: null, autoStart: false };
  const cron = c?.kind === 'schedule' ? c.cron : '0 8 * * 1';
  return {
    name: tr?.name ?? '', kind: k,
    preset: c?.kind === 'webhook' ? c.preset : 'alertmanager',
    dedupeField: c?.kind === 'webhook' ? c.dedupeField ?? '' : '',
    ignoreResolved: c?.kind === 'webhook' ? c.ignoreResolved : true,
    dedupeWindowMinutes: tr?.dedupeWindowMinutes ?? 60,
    from: c?.kind === 'mail' ? c.from : '', subjectContains: c?.kind === 'mail' ? c.subjectContains : '',
    folder: c?.kind === 'mail' ? c.folder : '', pollMinutes: c?.kind === 'mail' ? c.pollMinutes : 5,
    schedule: cronToSchedule(cron), cron,
    slackConnectorId: c?.kind === 'slack' ? c.connectorId : '', slackChannel: c?.kind === 'slack' ? c.channel : '#help-desk',
    slackFrom: c?.kind === 'slack' ? c.fromContains : '', slackText: c?.kind === 'slack' ? c.textContains : '',
    slackBots: c?.kind === 'slack' ? c.includeBots : true, slackWait: c?.kind === 'slack' ? !!c.waitForTicket : false, slackPoll: c?.kind === 'slack' ? c.pollMinutes : 5,
    slackNotify: c?.kind === 'slack' ? c.notifyUser ?? '' : '', slackDedupe: c?.kind === 'slack' ? c.dedupeOn ?? '' : '',
    slackWorkspaceUrl: c?.kind === 'slack' ? c.workspaceUrl ?? '' : '',
    jiraConnectorId: c?.kind === 'jira' ? c.connectorId : SLACK_VIA_CLAUDE, jql: c?.kind === 'jira' ? c.jql : 'project = HELP AND request-channel-type != api',
    jiraPoll: c?.kind === 'jira' ? c.pollMinutes : 5,
    jiraSite: c?.kind === 'jira' ? c.site ?? '' : '',
    blueprint: bp, tagsText: bp.tags.join(', '), costText: bp.costCapUsd === null ? '' : String(bp.costCapUsd),
  };
}

function configOf(d: Draft): TriggerConfig {
  if (d.kind === 'webhook') return { kind: 'webhook', preset: d.preset, ignoreResolved: d.ignoreResolved, ...(d.dedupeField.trim() ? { dedupeField: d.dedupeField.trim() } : {}) };
  if (d.kind === 'mail') return { kind: 'mail', from: d.from.trim(), subjectContains: d.subjectContains.trim(), folder: d.folder.trim(), pollMinutes: d.pollMinutes };
  if (d.kind === 'jira') return { kind: 'jira', connectorId: d.jiraConnectorId, jql: d.jql.trim(), pollMinutes: d.jiraPoll, ...(d.jiraConnectorId === SLACK_VIA_CLAUDE ? { site: d.jiraSite.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') } : {}) };
  if (d.kind === 'slack') return { kind: 'slack', connectorId: d.slackConnectorId, channel: d.slackChannel.trim(), fromContains: d.slackFrom.trim(), textContains: d.slackText.trim(), includeBots: d.slackBots, waitForTicket: d.slackWait, pollMinutes: d.slackPoll, ...(d.slackNotify ? { notifyUser: d.slackNotify } : {}), ...(d.slackDedupe ? { dedupeOn: d.slackDedupe } : {}), ...(d.slackConnectorId === SLACK_VIA_CLAUDE && d.slackWorkspaceUrl.trim() ? { workspaceUrl: d.slackWorkspaceUrl.trim() } : {}) };
  return { kind: 'schedule', cron: scheduleToCron(d.schedule, d.cron) };
}

function blueprintOf(d: Draft): TicketBlueprint {
  const cost = d.costText.trim() === '' ? null : Number(d.costText);
  return {
    ...d.blueprint,
    tags: d.tagsText.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean),
    costCapUsd: cost !== null && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

/** Next 3 runs of a cron, or the reason it is invalid. */
function usePreview(cron: string): { runs: Date[]; error: string | null } {
  return useMemo(() => {
    try {
      const runs = nextRuns(parseCron(cron), new Date(), 3);
      return runs.length ? { runs, error: null } : { runs: [], error: 'never' };
    } catch (err) {
      return { runs: [], error: (err as Error).message };
    }
  }, [cron]);
}

function TriggerEditor({ trigger, onClose, onCreated }: { trigger: Trigger | null; onClose: () => void; onCreated: (t: Trigger, secret: string | null) => void }) {
  const { state, api } = useStore();
  const { t, locale } = useI18n();
  const [d, setD] = useState<Draft>(() => draftFrom(trigger));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [fires, setFires] = useState<TriggerFire[] | null>(null);
  const [sample, setSample] = useState('');
  const [test, setTest] = useState<TriggerTestResult | null>(null);
  const [teams, setTeams] = useState<Array<{ id: Id; name: string }>>([]);
  const [slackConnectors, setSlackConnectors] = useState<ConnectorInfo[] | null>(null);
  const [jiraConnectors, setJiraConnectors] = useState<ConnectorInfo[] | null>(null);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const setBp = (patch: Partial<TicketBlueprint>) => setD((cur) => ({ ...cur, blueprint: { ...cur.blueprint, ...patch } }));
  const cron = scheduleToCron(d.schedule, d.cron);
  const preview = usePreview(cron);
  const firedV = (state.versions['trigger.fired'] ?? 0) + (state.versions['triggers.changed'] ?? 0);

  // Teams arrive with v0.4 §C; use them when this build has them.
  useEffect(() => {
    const listTeams = (api as unknown as { listTeams?: () => Promise<Array<{ id: Id; name: string }>> }).listTeams;
    if (listTeams) listTeams.call(api).then(setTeams, () => setTeams([]));
  }, [api]);

  useEffect(() => {
    api.listConnectors().then((r) => {
      const list = r.installed.filter((c) => c.catalogId === 'slack');
      setSlackConnectors(list);
      // New rules read through the owner's Claude Slack connector by default (no Slack app needed).
      setD((cur) => (cur.slackConnectorId ? cur : { ...cur, slackConnectorId: SLACK_VIA_CLAUDE }));
      const jira = r.installed.filter((c) => c.catalogId === 'atlassian');
      setJiraConnectors(jira);
    }, () => { setSlackConnectors([]); setJiraConnectors([]); });
  }, [api, state.connectorsVersion]);

  useEffect(() => {
    if (trigger) api.listTriggerFires(trigger.id, 20).then(setFires, () => setFires([]));
  }, [api, trigger, firedV]);

  const mailMissingFilter = d.kind === 'mail' && !d.from.trim() && !d.subjectContains.trim() && !d.folder.trim();
  const slackMissing = (d.kind === 'slack' && (!d.slackConnectorId || !d.slackChannel.trim())) || (d.kind === 'jira' && (!d.jiraConnectorId || !d.jql.trim() || (d.jiraConnectorId === SLACK_VIA_CLAUDE && !d.jiraSite.trim())));
  const invalid = !d.name.trim() || !d.blueprint.title.trim() || !d.blueprint.goal.trim() || mailMissingFilter || slackMissing || (d.kind === 'schedule' && !!preview.error);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: d.name.trim(), config: configOf(d), blueprint: blueprintOf(d), ...(d.kind === 'webhook' ? { dedupeWindowMinutes: d.dedupeWindowMinutes } : {}) };
      if (trigger) {
        await api.updateTrigger(trigger.id, body);
        onClose();
      } else {
        const res = await api.createTrigger(body);
        onCreated(res.trigger, res.secret);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!trigger || !window.confirm(t('trg.deleteConfirm', { name: trigger.name }))) return;
    try {
      await api.deleteTrigger(trigger.id);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const rotate = async () => {
    if (!trigger || !window.confirm(t('trg.rotateConfirm'))) return;
    try {
      setSecret((await api.rotateTriggerSecret(trigger.id)).secret);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const runTest = async () => {
    if (!trigger) return;
    setTest(null);
    setError(null);
    let payload: unknown;
    if (sample.trim()) {
      try {
        payload = JSON.parse(sample);
      } catch {
        setError(t('trg.testBadJson'));
        return;
      }
    }
    try {
      setTest(await api.testTrigger(trigger.id, payload === undefined ? {} : { payload }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => ({
    i, label: new Date(2026, 10, 15 + i).toLocaleDateString(locale, { weekday: 'long' }), // 2026-11-15 is a Sunday
  })), [locale]);
  const projects = Object.values(state.projects ?? {}).filter((p) => !p.archived);
  const agents = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));
  const teamValue = d.blueprint.teamId === null ? '' : d.blueprint.teamId;

  return (
    <form className="trg-editor" onSubmit={(e) => void save(e)}>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>← {t('trg.back')}</button>
      {!trigger && (
        <div className="trg-tabs" role="tablist" aria-label={t('trg.heading')}>
          {KINDS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={d.kind === k} className={`trg-tab${d.kind === k ? ' trg-tab--on' : ''}`}
              onClick={() => setD((cur) => ({ ...draftFrom(null, k), name: cur.name }))}>
              <span aria-hidden="true">{KIND_ICON[k]}</span> {t(`trg.kind.${k}` as MessageKey)}
            </button>
          ))}
        </div>
      )}
      <p className="small muted">{t(`trg.kindHint.${d.kind}` as MessageKey)}</p>
      <label className="field">
        <span className="field__label">{t('trg.name')}</span>
        <input className="input" required maxLength={100} value={d.name} placeholder={t('trg.namePlaceholder')} onChange={(e) => set({ name: e.target.value })} />
      </label>

      {d.kind === 'webhook' && (
        <fieldset className="trg-group">
          <label className="field">
            <span className="field__label">{t('trg.preset')}</span>
            <select className="input" value={d.preset} onChange={(e) => set({ preset: e.target.value as WebhookPreset })}>
              {PRESETS.map((p) => <option key={p} value={p}>{p === 'generic' ? `${presetLabel(p)} (script, Teams/Slack workflow…)` : presetLabel(p)}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={d.ignoreResolved} onChange={(e) => set({ ignoreResolved: e.target.checked })} /> {t('trg.ignoreResolved')}
          </label>
          <label className="field">
            <span className="field__label">{t('trg.dedupe')}</span>
            <input className="input input--sm" type="number" min={0} max={10080} value={d.dedupeWindowMinutes} onChange={(e) => set({ dedupeWindowMinutes: Math.max(0, Number(e.target.value) || 0) })} />
            <span className="small muted">{t('trg.dedupeHint')}</span>
          </label>
          <details>
            <summary className="small">{t('trg.dedupeField')}</summary>
            <input className="input" maxLength={200} value={d.dedupeField} placeholder="alerts.0.fingerprint" onChange={(e) => set({ dedupeField: e.target.value })} />
            <span className="small muted">{t('trg.dedupeFieldHint')}</span>
          </details>
          {trigger && <HookAccess trigger={trigger} secret={secret} onRotate={() => void rotate()} />}
        </fieldset>
      )}

      {d.kind === 'mail' && (
        <fieldset className="trg-group">
          {!state.mail?.connected && <p className="trg-warn" role="note">{t('trg.mail.noMailbox')}</p>}
          <label className="field">
            <span className="field__label">{t('trg.mail.from')}</span>
            <input className="input" maxLength={200} value={d.from} placeholder={t('trg.mail.fromPlaceholder')} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">{t('trg.mail.subject')}</span>
            <input className="input" maxLength={200} value={d.subjectContains} placeholder={t('trg.mail.subjectPlaceholder')} onChange={(e) => set({ subjectContains: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">{t('trg.mail.folder')}</span>
            <input className="input" maxLength={100} value={d.folder} onChange={(e) => set({ folder: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">{t('trg.mail.poll')}</span>
            <input className="input input--sm" type="number" min={2} max={1440} value={d.pollMinutes} onChange={(e) => set({ pollMinutes: Math.max(2, Number(e.target.value) || 2) })} />
          </label>
          {mailMissingFilter && <p className="small trg-warn">{t('trg.mail.needFilter')}</p>}
          <p className="small muted">{t('trg.mail.untrusted')}</p>
        </fieldset>
      )}

      {d.kind === 'jira' && (
        <fieldset className="trg-group">
          <label className="field">
            <span className="field__label">{t('trg.jira.connector')}</span>
            <select className="input" value={d.jiraConnectorId} onChange={(e) => set({ jiraConnectorId: e.target.value })}>
              <option value={SLACK_VIA_CLAUDE}>{t('trg.jira.viaClaude')}</option>
              {(jiraConnectors ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ` (${t('conn.status.off')})`}</option>)}
            </select>
            {d.jiraConnectorId === SLACK_VIA_CLAUDE && <span className="small muted">{t('trg.jira.viaClaudeHint')}</span>}
          </label>
          {d.jiraConnectorId === SLACK_VIA_CLAUDE && (
            <label className="field">
              <span className="field__label">{t('trg.jira.site')}</span>
              <input className="input" required maxLength={200} value={d.jiraSite} placeholder="acme.atlassian.net" onChange={(e) => set({ jiraSite: e.target.value })} />
            </label>
          )}
          <label className="field">
            <span className="field__label">{t('trg.jira.jql')}</span>
            <textarea className="input trg-mono" rows={2} required maxLength={2000} value={d.jql} onChange={(e) => set({ jql: e.target.value })} />
            <span className="small muted">{t('trg.jira.jqlHint')}</span>
          </label>
          <label className="field">
            <span className="field__label">{t('trg.mail.poll')}</span>
            <input className="input input--sm" type="number" min={1} max={1440} value={d.jiraPoll} onChange={(e) => set({ jiraPoll: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
          <p className="small muted">{t('trg.jira.untrusted')}</p>
        </fieldset>
      )}

      {d.kind === 'slack' && (
        <fieldset className="trg-group">
          <label className="field">
            <span className="field__label">{t('trg.slack.connector')}</span>
            <select className="input" value={d.slackConnectorId} onChange={(e) => set({ slackConnectorId: e.target.value })}>
              <option value={SLACK_VIA_CLAUDE}>{t('trg.slack.viaClaude')}</option>
              {(slackConnectors ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ` (${t('conn.status.off')})`}</option>)}
            </select>
            {d.slackConnectorId === SLACK_VIA_CLAUDE && <span className="small muted">{t('trg.slack.viaClaudeHint')}</span>}
          </label>
          {d.slackConnectorId === SLACK_VIA_CLAUDE && (
            <label className="field">
              <span className="field__label">{t('trg.slack.workspaceUrl')}</span>
              <input className="input" type="url" maxLength={200} value={d.slackWorkspaceUrl} placeholder="https://acme.slack.com" onChange={(e) => set({ slackWorkspaceUrl: e.target.value })} />
              <span className="small muted">{t('trg.slack.workspaceUrlHint')}</span>
            </label>
          )}
          <label className="field">
            <span className="field__label">{t('trg.slack.channel')}</span>
            <input className="input" required maxLength={100} value={d.slackChannel} placeholder="#help-desk" onChange={(e) => set({ slackChannel: e.target.value })} />
            <span className="small muted">{t('trg.slack.channelHint')}</span>
          </label>
          <label className="field">
            <span className="field__label">{t('trg.slack.from')}</span>
            <input className="input" maxLength={200} value={d.slackFrom} placeholder={t('trg.slack.fromPlaceholder')} onChange={(e) => set({ slackFrom: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">{t('trg.slack.text')}</span>
            <input className="input" maxLength={200} value={d.slackText} placeholder={t('trg.slack.textPlaceholder')} onChange={(e) => set({ slackText: e.target.value })} />
          </label>
          <label className="check"><input type="checkbox" checked={d.slackBots} onChange={(e) => set({ slackBots: e.target.checked })} /><span>{t('trg.slack.bots')}</span></label>
          <label className="check"><input type="checkbox" checked={d.slackWait} onChange={(e) => set({ slackWait: e.target.checked })} /><span>{t('trg.slack.wait')}</span></label>
          <label className="field">
            <span className="field__label">{t('trg.mail.poll')}</span>
            <input className="input input--sm" type="number" min={1} max={1440} value={d.slackPoll} onChange={(e) => set({ slackPoll: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
          <p className="small muted">{t('trg.slack.untrusted')}</p>
        </fieldset>
      )}

      {d.kind === 'schedule' && (
        <fieldset className="trg-group">
          <label className="field">
            <span className="field__label">{t('trg.sch.when')}</span>
            <select className="input" value={d.schedule.mode} onChange={(e) => {
              const mode = e.target.value as ScheduleMode;
              set({ schedule: { ...d.schedule, mode }, ...(mode === 'advanced' ? { cron } : {}) });
            }}>
              {(['daily', 'weekdays', 'weekly', 'monthly', 'advanced'] as ScheduleMode[]).map((m) => <option key={m} value={m}>{t(`trg.sch.${m}` as MessageKey)}</option>)}
            </select>
          </label>
          {d.schedule.mode === 'weekly' && (
            <label className="field">
              <span className="field__label">{t('trg.sch.day')}</span>
              <select className="input" value={d.schedule.weekday} onChange={(e) => set({ schedule: { ...d.schedule, weekday: Number(e.target.value) } })}>
                {[1, 2, 3, 4, 5, 6, 0].map((i) => <option key={i} value={i}>{days[i]!.label}</option>)}
              </select>
            </label>
          )}
          {d.schedule.mode !== 'advanced' ? (
            <label className="field">
              <span className="field__label">{t('trg.sch.time')}</span>
              <input className="input input--sm" type="time" value={d.schedule.time} onChange={(e) => set({ schedule: { ...d.schedule, time: e.target.value } })} />
            </label>
          ) : (
            <label className="field">
              <span className="field__label">{t('trg.sch.cron')}</span>
              <input className="input trg-mono" value={d.cron} maxLength={100} onChange={(e) => set({ cron: e.target.value })} />
              <span className="small muted">{t('trg.sch.cronHint')}</span>
            </label>
          )}
          {preview.error ? (
            <p className="small trg-warn" role="alert">{t('trg.sch.invalid', { reason: preview.error })}</p>
          ) : (
            <div className="small">
              <strong>{t('trg.sch.next')}:</strong>{' '}
              {preview.runs.map((r) => r.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join(' · ')}
              <span className="muted"> ({cron})</span>
            </div>
          )}
          <p className="small muted">{t('trg.sch.missed')}</p>
        </fieldset>
      )}

      <fieldset className="trg-group">
        <legend className="section-label">{t('trg.bp.heading')}</legend>
        <label className="field">
          <span className="field__label">{t('trg.bp.title')}</span>
          <input className="input" required maxLength={300} value={d.blueprint.title} onChange={(e) => setBp({ title: e.target.value })} />
        </label>
        <label className="field">
          <span className="field__label">{t('trg.bp.goal')}</span>
          <textarea className="input" required rows={4} maxLength={10000} value={d.blueprint.goal} onChange={(e) => setBp({ goal: e.target.value })} />
          <span className="small muted">{t('trg.bp.placeholders')}</span>
        </label>
        <div className="trg-row">
          <label className="field">
            <span className="field__label">{t('trg.bp.team')}</span>
            <select className="input" value={teamValue} onChange={(e) => setBp({ teamId: e.target.value === '' ? null : e.target.value })}>
              <option value="">{t('trg.bp.teamNone')}</option>
              <option value="auto">{t('trg.bp.teamAuto')}</option>
              {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('trg.bp.agent')}</span>
            <select className="input" value={d.blueprint.agentId ?? ''} onChange={(e) => setBp({ agentId: e.target.value || null })}>
              <option value="">{t('trg.bp.agentAuto')}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.role ? `${a.name} (${a.role})` : a.name}</option>)}
            </select>
          </label>
        </div>
        <div className="trg-row">
          <label className="field">
            <span className="field__label">{t('trg.bp.project')}</span>
            <select className="input" value={d.blueprint.projectId ?? ''} onChange={(e) => setBp({ projectId: e.target.value || null })}>
              <option value="">{t('trg.bp.projectNone')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('trg.bp.cost')}</span>
            <input className="input" type="number" min={0} step={0.1} value={d.costText} onChange={(e) => set({ costText: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span className="field__label">{t('trg.bp.tags')}</span>
          <input className="input" value={d.tagsText} placeholder="alert, naples" onChange={(e) => set({ tagsText: e.target.value })} />
        </label>
        <div className="trg-radio" role="radiogroup">
          <label className="check"><input type="radio" name="trg-start" checked={!d.blueprint.autoStart} onChange={() => setBp({ autoStart: false })} /> {t('trg.bp.backlog')}</label>
          <label className="check"><input type="radio" name="trg-start" checked={d.blueprint.autoStart} onChange={() => setBp({ autoStart: true })} /> {t('trg.bp.start')}</label>
        </div>
      </fieldset>

      {error && <p className="mail-error" role="alert">{error}</p>}
      <div className="trg-actions">
        <button type="submit" className="btn btn--primary" disabled={busy || invalid}>{busy ? t('trg.saving') : trigger ? t('trg.save') : t('trg.create')}</button>
        <button type="button" className="btn btn--ghost" onClick={onClose}>{t('trg.cancel')}</button>
        {trigger && <button type="button" className="btn btn--outline trg-delete" onClick={() => void remove()}>{t('trg.delete')}</button>}
      </div>

      {trigger && (
        <section className="trg-group" aria-label={t('trg.test')}>
          <h3 className="section-label">{t('trg.test')}</h3>
          <p className="small muted">{t('trg.testHint')}</p>
          {trigger.kind !== 'schedule' && (
            <label className="field">
              <span className="field__label">{t('trg.testPayload')}</span>
              <textarea className="input trg-mono" rows={4} value={sample} onChange={(e) => setSample(e.target.value)}
                placeholder={trigger.kind === 'mail' ? '{"from": "alerts@example.com", "subject": "Backup failed", "text": "…"}' : trigger.kind === 'slack' ? '{"from": "Jane Doe", "text": "My VPN does not connect"}' : trigger.kind === 'jira' ? '{"key": "HELP-123", "summary": "Wi-Fi not working", "reporter": "Jane Doe"}' : '{"title": "Disk almost full", "severity": "warning", "host": "fs01"}'} />
            </label>
          )}
          <button type="button" className="btn btn--outline btn--sm" onClick={() => void runTest()}>{t('trg.testRun')}</button>
          {test && (
            <div className="trg-test" role="status">
              <strong>{t(`trg.test.${test.outcome === 'commented' ? 'commented' : test.outcome === 'created' ? 'created' : 'ignored'}` as MessageKey)}</strong>
              <p className="small">{test.detail}</p>
              <div className="trg-test__title">{test.title}</div>
              <pre className="trg-test__goal">{test.goal}</pre>
            </div>
          )}
        </section>
      )}

      {trigger && (
        <section className="trg-group" aria-label={t('trg.fires')}>
          <h3 className="section-label">{t('trg.fires')}</h3>
          {fires === null ? null : fires.length === 0 ? <p className="small muted">{t('trg.firesEmpty')}</p> : (
            <ul className="trg-fires">
              {fires.map((f) => (
                <li key={f.id} className={`trg-fire trg-fire--${f.outcome}`}>
                  <span className="trg-fire__outcome">{t(`trg.outcome.${f.outcome}` as MessageKey)}</span>
                  <span className="small">{f.detail}</span>
                  <time className="small muted" dateTime={f.at}>{formatRelative(f.at, locale)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ dialog

export function Triggers({ onClose }: { onClose: () => void }) {
  const { state, api } = useStore();
  const { t, locale } = useI18n();
  const [list, setList] = useState<Trigger[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Trigger | 'new' | null>(null);
  const [created, setCreated] = useState<{ trigger: Trigger; secret: string | null } | null>(null);
  const version = (state.versions['triggers.changed'] ?? 0) + (state.versions['trigger.fired'] ?? 0);

  const load = useCallback(() => {
    api.listTriggers().then((l) => { setList(l); setError(null); }, (err) => setError(errorMessage(err)));
  }, [api]);
  useEffect(load, [load, version]);

  const toggle = async (tr: Trigger) => {
    try {
      await api.updateTrigger(tr.id, { enabled: !tr.enabled });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const close = () => { setEditing(null); load(); };

  let body;
  if (created) {
    body = (
      <div className="trg-editor">
        <h3 className="trg-created"><span aria-hidden="true">{KIND_ICON[created.trigger.kind]}</span> {created.trigger.name}</h3>
        {created.trigger.kind === 'webhook' && <HookAccess trigger={created.trigger} secret={created.secret} />}
        <button type="button" className="btn btn--primary" onClick={() => { setCreated(null); load(); }}>{t('trg.done')}</button>
      </div>
    );
  } else if (editing) {
    const current = editing === 'new' ? null : list?.find((x) => x.id === editing.id) ?? editing;
    body = <TriggerEditor key={current?.id ?? 'new'} trigger={current} onClose={close} onCreated={(trigger, secret) => { setEditing(null); setCreated({ trigger, secret }); }} />;
  } else {
    body = (
      <>
        <p className="small muted">{t('trg.intro')}</p>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing('new')}>+ {t('trg.new')}</button>
        {error && <p className="mail-error" role="alert">{error}</p>}
        {list === null ? <p className="small muted" role="status">{t('panel.loading')}</p>
          : list.length === 0 ? <p className="trusted__empty">{t('trg.empty')}</p>
          : (
            <ul className="trg-list">
              {list.map((tr) => (
                <li key={tr.id} className={`trg-item${tr.enabled ? '' : ' trg-item--off'}`}>
                  <span className="trg-item__icon" aria-hidden="true">{KIND_ICON[tr.kind]}</span>
                  <div className="trg-item__text">
                    <strong>{tr.name}</strong>
                    <span className="small muted">{t(`trg.kind.${tr.kind}` as MessageKey)} · {describe(tr)}</span>
                    <span className="small muted">
                      {tr.lastFiredAt ? t('trg.lastFired', { when: formatRelative(tr.lastFiredAt, locale) }) : t('trg.neverFired')} · {t('trg.count', { count: tr.fireCount })}
                    </span>
                  </div>
                  <label className="trg-switch" title={t('trg.toggle', { name: tr.name })}>
                    <input type="checkbox" role="switch" checked={tr.enabled} aria-label={t('trg.toggle', { name: tr.name })} onChange={() => void toggle(tr)} />
                    <span>{tr.enabled ? t('trg.on') : t('trg.off')}</span>
                  </label>
                  <button type="button" className="btn btn--outline btn--sm" onClick={() => setEditing(tr)}>{t('trg.edit')}</button>
                </li>
              ))}
            </ul>
          )}
      </>
    );
  }

  return (
    <Dialog title={t('trg.heading')} onClose={onClose} wide>
      {body}
    </Dialog>
  );
}
