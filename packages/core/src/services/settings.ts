/** Workspace settings API. */
import type { AppSettings } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { unavailable } from './errors.js';

export function getSettings(ctx: AppContext): AppSettings {
  const settings = ctx.settings?.get() ?? { ...DEFAULT_SETTINGS };
  // A workspace that already has tickets counts as set up: existing users never see the wizard.
  if (!settings.setupCompleted && ctx.repos.tickets.list({ limit: 1 }).items.length > 0) settings.setupCompleted = true;
  return settings;
}

export function updateSettings(ctx: AppContext, patch: Partial<AppSettings>): AppSettings {
  if (!ctx.settings) throw unavailable('Settings are not available in this build');
  ctx.settings.update(patch);
  return getSettings(ctx);
}
