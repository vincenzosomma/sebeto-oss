/**
 * "Export diagnostics": one redacted JSON report the owner can review and attach to a bug report
 * (docs/15 Architecture Review.md, item 16; docs/13 Local-first & Privacy.md). It holds versions,
 * counts and recent problems, never ticket titles/goals/messages, keys, passwords or tokens, and
 * every string goes through the redactor before it leaves.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiagnosticsReport } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { createRedactor, redactDeep, type RedactorOptions } from '../diagnostics/redact.js';
import { listRuntimes } from './agents.js';
import { getSettings } from './settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DIAGNOSTICS_LIMITS = { errors: 50, failedRuns: 20 } as const;

function detectShell(): DiagnosticsReport['app']['shell'] {
  if (process.versions.electron || 'parentPort' in process) return 'desktop';
  const env = process.env;
  if (env.container || env.KUBERNETES_SERVICE_HOST) return 'container';
  try { if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) return 'container'; } catch { /* ignore */ }
  return 'server';
}

function hostOf(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
}

/** Builds the report. `redaction` overrides the home folder / user name (tests). */
export async function buildDiagnostics(ctx: AppContext, opts: { now?: Date; redaction?: RedactorOptions } = {}): Promise<DiagnosticsReport> {
  const now = opts.now ?? new Date();
  const stats = ctx.repos.stats;

  const runtimes = await listRuntimes(ctx).catch(() => []);
  const mail = ctx.mail?.status() ?? { connected: false as const };
  const oauthApps = ctx.oauth ? await ctx.oauth.apps().catch(() => []) : [];
  const custom = ctx.connectors?.list() ?? [];

  const report: DiagnosticsReport = {
    format: 'sebeto-diagnostics/1',
    app: {
      version: ctx.config.version,
      generatedAt: now.toISOString(),
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      shell: detectShell(),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      uptimeSeconds: Math.round(process.uptime()),
      workspace: ctx.config.workspaceDir,
      maxParallelRuns: ctx.config.maxParallelRuns,
      enabledRuntimes: [...ctx.config.runtimes],
    },
    storage: {
      schemaVersion: stats?.schemaVersion() ?? null,
      dbBytes: stats?.dbBytes() ?? null,
      ticketsByStatus: stats?.ticketsByStatus() ?? {},
      agents: stats?.agentCount() ?? ctx.repos.agents.list().length,
      skills: ctx.skills ? ctx.skills.list().length : null,
      runsLast7Days: stats?.runsByStatusSince(new Date(now.getTime() - 7 * DAY_MS).toISOString()) ?? {},
      jobsByState: stats?.jobsByState() ?? {},
    },
    runtimes: runtimes.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      installed: r.detection.installed,
      version: r.detection.version ?? null,
      loggedIn: r.detection.loggedIn ?? null,
      problem: r.detection.problem ?? null,
      models: r.models.length,
    })),
    settings: (() => {
      const s = getSettings(ctx);
      return { intakeModel: s.intakeModel, setupCompleted: s.setupCompleted };
    })(),
    connectors: {
      mail: mail.connected ? { connected: true, provider: mail.provider, address: mail.address, calendar: mail.calendar } : { connected: false },
      oauthApps: oauthApps.map((a) => ({ provider: a.provider, source: a.source })),
      custom: custom.map((c) => {
        const toolsByLevel: Record<string, number> = {};
        for (const t of c.tools) toolsByLevel[t.level] = (toolsByLevel[t.level] ?? 0) + 1;
        return {
          catalogId: c.catalogId,
          transport: c.transport.type,
          host: c.transport.type === 'http' ? hostOf(c.transport.url) : null,
          enabled: c.enabled,
          status: c.status,
          error: c.error,
          toolsByLevel,
          unreviewedTools: c.tools.filter((t) => !t.reviewed).length,
        };
      }),
    },
    recentProblems: {
      errors: (stats?.recentErrors(DIAGNOSTICS_LIMITS.errors) ?? []).map((e) => ({ ticket: `T-${e.ticketNumber}`, at: e.at, summary: e.summary })),
      failedRuns: (stats?.recentFailedRuns(DIAGNOSTICS_LIMITS.failedRuns) ?? []).map((r) => ({
        ticket: `T-${r.ticketNumber}`, at: r.at, trigger: r.trigger, exitReason: r.exitReason,
      })),
    },
  };

  // The API token and the secrets folder (<workspace>/secrets, either slash style) are hidden outright.
  const secretsDir = path.join(ctx.config.workspaceDir, 'secrets');
  const redact = createRedactor({
    ...opts.redaction,
    secrets: [ctx.config.apiToken, secretsDir, secretsDir.replace(/\\/g, '/'), `${ctx.config.workspaceDir}\\secrets`, ...(opts.redaction?.secrets ?? [])],
  });
  return redactDeep(report, redact);
}

/** File name for the download: sebeto-diagnostics-YYYY-MM-DD.json */
export function diagnosticsFileName(now = new Date()): string {
  return `sebeto-diagnostics-${now.toISOString().slice(0, 10)}.json`;
}
