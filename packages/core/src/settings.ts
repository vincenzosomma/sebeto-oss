/**
 * Workspace settings that are not tied to an agent (docs/24 Intake Chat.md). Stored as
 * <workspace>/settings.json; unknown or invalid values fall back to the defaults.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '@sebeto/shared';

export const DEFAULT_SETTINGS: AppSettings = {
  // Planning is short work: Haiku plans well at ~$0.004 per message (vs ~$0.08 on the default model).
  intakeModel: 'haiku',
  setupCompleted: false,
  // v0.4: the new-ticket form starts on "no team" until the owner chooses Automatic as the default.
  newTicketTeam: 'manual',
  autoTags: true,
  // Ticket cost caps and agent monthly budgets stop the agent (true) or only warn (false).
  budgetBlocks: true,
};

/** A list of Claude connector names: trimmed, 1–120 characters, at most 30, no duplicates. */
export function cleanConnectorNames(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 30) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') return null;
    const n = x.trim();
    if (!n || n.length > 120) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
/** Tool names: valid characters, at most 100, no duplicates. */
export function cleanToolNames(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 100) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') return null;
    const n = x.trim();
    if (!TOOL_RE.test(n)) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export interface SettingsStore {
  get(): AppSettings;
  update(patch: Partial<AppSettings>): AppSettings;
}

export function validModel(m: unknown): m is string | null {
  return m === null || (typeof m === 'string' && MODEL_RE.test(m));
}

export function createSettingsStore(workspaceDir: string): SettingsStore {
  const file = path.join(workspaceDir, 'settings.json');
  let current: AppSettings = { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppSettings>;
    if (validModel(raw.intakeModel)) current.intakeModel = raw.intakeModel;
    if (typeof raw.setupCompleted === 'boolean') current.setupCompleted = raw.setupCompleted;
    if (raw.newTicketTeam === 'manual' || raw.newTicketTeam === 'auto') current.newTicketTeam = raw.newTicketTeam;
    if (typeof raw.autoTags === 'boolean') current.autoTags = raw.autoTags;
    if (typeof raw.budgetBlocks === 'boolean') current.budgetBlocks = raw.budgetBlocks;
    const all = cleanConnectorNames(raw.claudeConnectorsAllAgents);
    if (all) current.claudeConnectorsAllAgents = all;
    const lookups = cleanToolNames(raw.claudeLookupTools);
    if (lookups) current.claudeLookupTools = lookups;
  } catch { /* first run or unreadable: defaults */ }

  return {
    get: () => ({ ...current }),
    update(patch) {
      const next = { ...current };
      if (patch.intakeModel !== undefined) {
        if (!validModel(patch.intakeModel)) throw new Error('Invalid model name');
        next.intakeModel = patch.intakeModel;
      }
      if (patch.setupCompleted !== undefined) {
        if (typeof patch.setupCompleted !== 'boolean') throw new Error('setupCompleted must be true or false');
        next.setupCompleted = patch.setupCompleted;
      }
      if (patch.newTicketTeam !== undefined) {
        if (patch.newTicketTeam !== 'manual' && patch.newTicketTeam !== 'auto') throw new Error("newTicketTeam must be 'manual' or 'auto'");
        next.newTicketTeam = patch.newTicketTeam;
      }
      if (patch.autoTags !== undefined) {
        if (typeof patch.autoTags !== 'boolean') throw new Error('autoTags must be true or false');
        next.autoTags = patch.autoTags;
      }
      if (patch.budgetBlocks !== undefined) {
        if (typeof patch.budgetBlocks !== 'boolean') throw new Error('budgetBlocks must be true or false');
        next.budgetBlocks = patch.budgetBlocks;
      }
      if (patch.claudeConnectorsAllAgents !== undefined) {
        const all = cleanConnectorNames(patch.claudeConnectorsAllAgents);
        if (!all) throw new Error('claudeConnectorsAllAgents must be a list of at most 30 connector names');
        next.claudeConnectorsAllAgents = all;
      }
      if (patch.claudeLookupTools !== undefined) {
        const lookups = cleanToolNames(patch.claudeLookupTools);
        if (!lookups) throw new Error('claudeLookupTools must be a list of at most 100 tool names');
        next.claudeLookupTools = lookups;
      }
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
      current = next;
      return { ...current };
    },
  };
}
