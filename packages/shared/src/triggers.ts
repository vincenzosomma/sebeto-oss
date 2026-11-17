/**
 * Triggers: tickets that open themselves (v0.4, docs/28 v0.4 Plan.md §D).
 *
 * - webhook:  an alert or message POSTed to Sebeto (Alertmanager, Grafana, Uptime Kuma, Zabbix, a
 *             script, a Teams/Slack workflow…). URL: POST /api/v1/hooks/:triggerId
 *             Auth (one of): header `Authorization: Bearer <secret>` or
 *             `X-Sebeto-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`. No session token needed.
 *             Max body 256 KB, 60 requests/minute per trigger, JSON only.
 * - mail:     new emails matching a rule in the connected mailbox (from / subject / folder), polled.
 * - schedule: a recurring task (cron, local time), e.g. "every Monday 08:00 check certificates".
 * - slack:    new messages in a Slack channel, through an installed Slack connector (polled).
 * - jira:     new Jira issues matching a JQL query, through an installed Atlassian connector (polled).
 *
 * Every fire is logged (trigger_fires + security log). Content that came from outside (webhook body,
 * email) is UNTRUSTED: the ticket's origin says so, and the agent's outbound actions always ask.
 * Repeats inside the dedupe window add a comment to the open ticket instead of a new ticket.
 *
 * API (under /api/v1):
 *   GET    /triggers                        → Trigger[]
 *   POST   /triggers  CreateTriggerBody     → CreateTriggerResponse (201; webhook secret shown ONCE)
 *   PATCH  /triggers/:id  UpdateTriggerBody → Trigger
 *   DELETE /triggers/:id                    → 204
 *   GET    /triggers/:id                    → Trigger
 *   POST   /triggers/:id/rotate-secret      → { secret: string } (webhook only, shown once)
 *   POST   /triggers/:id/test  { payload? } → TriggerTestResult (dry run: the ticket it WOULD create)
 *   GET    /triggers/:id/fires?limit=       → TriggerFire[] (newest first)
 *   POST   /hooks/:id                       → 202 { outcome, ticketNumber? }
 * WebSocket: { type: 'triggers.changed' } and { type: 'trigger.fired'; fire }
 */
import type { Id, IsoDate } from './types.js';
import type { TeamChoice } from './teams.js';

export type TriggerKind = 'webhook' | 'mail' | 'schedule' | 'slack' | 'jira';

export type WebhookPreset = 'generic' | 'alertmanager' | 'grafana' | 'uptime-kuma' | 'zabbix';

export interface WebhookConfig {
  kind: 'webhook';
  preset: WebhookPreset;
  /** Dotted path in the payload used to recognise repeats (preset default when absent). */
  dedupeField?: string;
  /** Payloads in a resolved/OK state only comment on the open ticket and never create one. */
  ignoreResolved: boolean;
}

export interface MailTriggerConfig {
  kind: 'mail';
  /** Case-insensitive "contains" filters; '' = not used. At least one must be set. */
  from: string;
  subjectContains: string;
  /** Mailbox folder / Gmail label; '' = inbox. */
  folder: string;
  pollMinutes: number;
}

export interface ScheduleConfig {
  kind: 'schedule';
  /** 5-field cron in local time: "0 8 * * 1" = Mondays 08:00. */
  cron: string;
}

/**
 * New messages in a Slack channel, read through an installed Slack connector (polled). One ticket
 * per new top-level message; thread replies, joins and edits are ignored, and so are messages sent
 * with the connector's own token (no loops when an agent posts back).
 */
/** Slack rule connectorId meaning "the owner's Claude Slack connector". */
export const SLACK_VIA_CLAUDE = 'claude';

export interface SlackTriggerConfig {
  kind: 'slack';
  /**
   * Installed connector with catalogId "slack", or SLACK_VIA_CLAUDE ("claude"): read through the
   * owner's own Claude Slack connector (no Slack app; channel must be an id; DMs to notifyUser then
   * go through the first installed Slack connector, if any).
   */
  connectorId: Id;
  /** "#help-desk" or a channel id. */
  channel: string;
  /** Case-insensitive "contains" on the sender's name; '' = anyone. */
  fromContains: string;
  /** Case-insensitive "contains" on the message text; '' = any message. */
  textContains: string;
  /** Also messages posted by apps and bots (Jira, workflows, monitoring). */
  includeBots: boolean;
  /**
   * Only messages that a ticketing app (e.g. Jira Service Management "Assist") turned into a ticket:
   * wait up to SLACK_TICKET_WAIT_MINUTES for a reply in the thread with a key such as HELP-123,
   * then fill {{issue}} / {{issue_url}}. Messages that never get a key are skipped.
   */
  waitForTicket?: boolean;
  /**
   * Slack user id (U…) to DM when a ticket from this rule needs the owner (Needs you / Blocked):
   * the ticket, the reason and the agent's latest message. '' / absent = no DM. Needs im:write.
   */
  notifyUser?: string;
  /**
   * Group repeats (e.g. the same alert posted again): a regular expression whose capture groups name
   * "the same thing" (e.g. alert title + endpoint). A message with the same groups while a ticket from
   * it is still open (within the rule's dedupe window) becomes a comment on that ticket. '' = off.
   */
  dedupeOn?: string;
  /**
   * Your Slack address, e.g. https://acme.slack.com. Only for SLACK_VIA_CLAUDE rules: the connector
   * gives no message links, so {{link}} is built from this (…/archives/<channel>/p<ts>). '' = no link.
   */
  workspaceUrl?: string;
  pollMinutes: number;
}

/** How long a Slack channel rule waits for the ticket key to appear in the thread. */
export const SLACK_TICKET_WAIT_MINUTES = 10;

/**
 * New Jira issues matching a JQL query, read through an installed Atlassian connector (polled).
 * One ticket per new issue (by created time); issues created before the rule was turned on are never used.
 */
export interface JiraTriggerConfig {
  kind: 'jira';
  /**
   * Installed connector with catalogId "atlassian", or SLACK_VIA_CLAUDE ("claude"): search through the
   * owner's own Claude Atlassian connector (no API token; needs `site`).
   */
  connectorId: Id;
  /** Atlassian address, e.g. acme.atlassian.net. Required with "claude". */
  site?: string;
  /** Claude connector name as `claude mcp list` shows it; '' = the first connected one with "Atlassian" in its name. */
  claudeServer?: string;
  /** e.g. project = HELP AND request-channel-type != api (no ORDER BY; Sebeto adds the time window). */
  jql: string;
  pollMinutes: number;
}

export type TriggerConfig = WebhookConfig | MailTriggerConfig | ScheduleConfig | SlackTriggerConfig | JiraTriggerConfig;

/**
 * The ticket a trigger creates. title/goal may use {{placeholders}}: {{title}}, {{summary}},
 * {{severity}}, {{host}}, {{from}}, {{subject}}, {{date}}, {{payload.some.path}}. Values are inserted
 * as plain text (quoted as untrusted in the goal), never as instructions.
 */
export interface TicketBlueprint {
  title: string;
  goal: string;
  teamId: TeamChoice;
  agentId: Id | null;
  projectId: Id | null;
  tags: string[];
  costCapUsd: number | null;
  /** Start the agent right away (true) or leave the ticket in Backlog for the owner (false, default). */
  autoStart: boolean;
}

export interface Trigger {
  id: Id;
  name: string;
  kind: TriggerKind;
  enabled: boolean;
  config: TriggerConfig;
  blueprint: TicketBlueprint;
  /** Repeats inside this window comment on the open ticket instead of creating one. 0 = never dedupe. */
  dedupeWindowMinutes: number;
  /** For webhooks: the path to call (relative to the core URL). */
  hookPath: string | null;
  /** A webhook secret is set (the secret itself is never returned after creation). */
  hasSecret: boolean;
  lastFiredAt: IsoDate | null;
  fireCount: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface CreateTriggerBody {
  name: string;
  config: TriggerConfig;
  blueprint: TicketBlueprint;
  dedupeWindowMinutes?: number;
  enabled?: boolean;
}
export interface UpdateTriggerBody { name?: string; enabled?: boolean; config?: TriggerConfig; blueprint?: TicketBlueprint; dedupeWindowMinutes?: number }
export interface CreateTriggerResponse { trigger: Trigger; /** Webhook only; shown once. */ secret: string | null }

export type TriggerFireOutcome = 'created' | 'commented' | 'ignored' | 'rejected' | 'error';

export interface TriggerFire {
  id: Id;
  triggerId: Id;
  at: IsoDate;
  outcome: TriggerFireOutcome;
  ticketId: Id | null;
  ticketNumber: number | null;
  /** Plain-language reason ("bad signature", "repeat of T-31", "resolved alert"). */
  detail: string;
}

export interface TriggerTestResult { outcome: TriggerFireOutcome; title: string; goal: string; teamId: Id | null; agentId: Id | null; tags: string[]; detail: string }

/** Where a ticket came from. Tickets with an untrusted origin make outbound actions always ask. */
export interface TicketOrigin {
  kind: 'manual' | 'intake' | 'trigger' | 'session';
  triggerId?: Id;
  triggerKind?: TriggerKind;
  /** Session library entry it was opened from. */
  sessionEntryId?: Id;
  /** Short source label ("Alertmanager", "mail from it-alerts@…"). */
  source?: string;
  untrusted: boolean;
}

export const HOOK_MAX_BYTES = 256 * 1024;
export const HOOK_RATE_PER_MINUTE = 60;

// ---- v0.4 D additions (additive)
/** POST /triggers/:id/test body: a sample payload (webhook JSON; mail: { from, subject, text }); absent = the preset's sample. */
export interface TriggerTestBody { payload?: unknown }
/** POST /triggers/:id/rotate-secret response (the new secret is shown once). */
export interface RotateSecretResponse { secret: string }
/** POST /hooks/:id accepted response (202). Never echoes the payload. */
export interface HookResponse { outcome: TriggerFireOutcome; ticketNumber?: number }
/** Minimum poll interval for mail rules (minutes). */
export const MAIL_POLL_MIN_MINUTES = 2;
/** Minimum poll interval for Slack channel rules (minutes). */
export const SLACK_POLL_MIN_MINUTES = 1;
/** Labels for the webhook presets (UI + the ticket origin source). */
export const WEBHOOK_PRESET_LABELS: Record<WebhookPreset, string> = {
  generic: 'Webhook', alertmanager: 'Alertmanager', grafana: 'Grafana', 'uptime-kuma': 'Uptime Kuma', zabbix: 'Zabbix',
};
