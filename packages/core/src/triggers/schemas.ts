/** zod validators for the trigger API (shapes mirror packages/shared/src/triggers.ts). */
import { z } from 'zod';
import { MAIL_POLL_MIN_MINUTES, SLACK_POLL_MIN_MINUTES, SLACK_VIA_CLAUDE, cronProblem } from '@sebeto/shared';

const id = z.string().min(1).max(100);
const money = z.number().finite().min(0).max(1_000_000);

const webhookConfig = z.object({
  kind: z.literal('webhook'),
  preset: z.enum(['generic', 'alertmanager', 'grafana', 'uptime-kuma', 'zabbix']),
  dedupeField: z.string().trim().max(200).regex(/^$|^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'Use a dotted path like alerts.0.fingerprint').optional(),
  ignoreResolved: z.boolean().default(true),
}).strict();

const mailConfig = z.object({
  kind: z.literal('mail'),
  from: z.string().trim().max(200).default(''),
  subjectContains: z.string().trim().max(200).default(''),
  folder: z.string().trim().max(100).regex(/^[^"\\\r\n]*$/, 'The folder name cannot contain quotes or backslashes').default(''),
  pollMinutes: z.number().int().min(MAIL_POLL_MIN_MINUTES).max(24 * 60).default(5),
}).strict();

const scheduleConfig = z.object({
  kind: z.literal('schedule'),
  cron: z.string().trim().min(1).max(100),
}).strict();

const slackConfig = z.object({
  kind: z.literal('slack'),
  connectorId: id.or(z.literal(SLACK_VIA_CLAUDE)),
  channel: z.string().trim().min(1, 'Choose a channel').max(100).regex(/^#?[A-Za-z0-9._-]+$/, 'Use a channel name like #help-desk or a channel id'),
  fromContains: z.string().trim().max(200).default(''),
  textContains: z.string().trim().max(200).default(''),
  includeBots: z.boolean().default(true),
  waitForTicket: z.boolean().default(false),
  notifyUser: z.string().trim().max(30).regex(/^([UW][A-Z0-9]{2,})?$/, 'Use a Slack user id like U0123ABC').default(''),
  dedupeOn: z.string().max(300).default('').refine((r) => { try { new RegExp(r); return true; } catch { return false; } }, 'Not a valid regular expression'),
  workspaceUrl: z.string().trim().max(200).regex(/^(https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com\/?)?$/, 'Use your Slack address, like https://acme.slack.com').default(''),
  pollMinutes: z.number().int().min(SLACK_POLL_MIN_MINUTES).max(24 * 60).default(2),
}).strict();

const jiraConfig = z.object({
  kind: z.literal('jira'),
  connectorId: id.or(z.literal(SLACK_VIA_CLAUDE)),
  site: z.string().trim().max(200).regex(/^([a-z0-9-]+\.atlassian\.net)?$/, 'Use your Atlassian address, like acme.atlassian.net').default(''),
  claudeServer: z.string().trim().max(100).default(''),
  jql: z.string().trim().min(1, 'Enter a JQL query').max(2000).refine((q) => !/\border\s+by\b/i.test(q), 'Leave out ORDER BY; Sebeto sorts by creation time'),
  pollMinutes: z.number().int().min(1).max(24 * 60).default(2),
}).strict();

export const triggerConfig = z.discriminatedUnion('kind', [webhookConfig, mailConfig, scheduleConfig, slackConfig, jiraConfig]).superRefine((c, ctx) => {
  if (c.kind === 'jira' && c.connectorId === SLACK_VIA_CLAUDE && !c.site) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['site'], message: 'Enter your Atlassian address, like acme.atlassian.net' });
  }
  if (c.kind === 'mail' && !c.from && !c.subjectContains && !c.folder) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'A mail rule needs at least one filter: sender, subject or folder' });
  }
  if (c.kind === 'schedule') {
    const problem = cronProblem(c.cron);
    if (problem) ctx.addIssue({ code: 'custom', path: ['cron'], message: problem });
  }
});

export const ticketBlueprint = z.object({
  title: z.string().trim().min(1).max(300),
  goal: z.string().trim().min(1).max(10_000),
  teamId: z.union([z.literal('auto'), id, z.null()]).default(null),
  agentId: id.nullable().default(null),
  projectId: id.nullable().default(null),
  tags: z.array(z.string().max(64)).max(20).default([]),
  costCapUsd: money.nullable().default(null),
  autoStart: z.boolean().default(false),
}).strict();

const name = z.string().trim().min(1).max(100);
const dedupeWindow = z.number().int().min(0).max(7 * 24 * 60);

export const createTriggerBody = z.object({
  name,
  config: triggerConfig,
  blueprint: ticketBlueprint,
  dedupeWindowMinutes: dedupeWindow.optional(),
  enabled: z.boolean().optional(),
}).strict();

export const updateTriggerBody = z.object({
  name: name.optional(),
  enabled: z.boolean().optional(),
  config: triggerConfig.optional(),
  blueprint: ticketBlueprint.optional(),
  dedupeWindowMinutes: dedupeWindow.optional(),
}).strict();

export const testTriggerBody = z.object({ payload: z.unknown().optional() }).strict();

export const firesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });
