/**
 * Skills v1 (docs/17 Agents & Skills.md): reusable know-how attached to agents.
 * Each skill is a folder <workspace>/skills/<slug>/ with a SKILL.md (YAML frontmatter + instructions)
 * and optional supporting files. Files are the source of truth; assignments live in the database.
 *
 * API (all under /api/v1):
 *   GET    /skills                 → Skill[]
 *   POST   /skills                 SkillBody → Skill (201; slug derived from name)
 *   PUT    /skills/:slug           SkillBody → Skill
 *   DELETE /skills/:slug           → 204 (also unassigns it everywhere)
 *   PUT    /agents/:id/skills      AssignSkillsBody → Agent (replaces the agent's skill list)
 * WebSocket: { type: 'skills.changed' } after any change; agent changes also send agent.updated.
 */
import type { Id, IsoDate, PermissionKey } from './types.js';

export interface Skill {
  /** Folder name, lowercase a-z0-9-, unique. */
  slug: string;
  name: string;
  /** One line: what the skill helps with. */
  description: string;
  /** The SKILL.md body: how to do the task well, in plain language (Markdown). */
  instructions: string;
  /**
   * Permissions the skill needs to work (e.g. ['fs.read', 'email.send']). Informational in v1:
   * Sebeto never loosens an agent's own settings; the UI warns when an agent has "Never" for one.
   */
  needs: PermissionKey[];
  /** Connector catalog ids or connector names the skill expects (e.g. ['gmail']). Informational. */
  connectors: string[];
  /** Supporting files inside the skill folder (relative paths), excluding SKILL.md. */
  files: string[];
  version: number;
  updatedAt: IsoDate;
  /** Ids of agents that have this skill. */
  usedBy: Id[];
}

export interface SkillBody {
  name: string;
  description: string;
  instructions: string;
  needs?: PermissionKey[];
  connectors?: string[];
}

export interface AssignSkillsBody { skills: string[] }
