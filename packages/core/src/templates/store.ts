/**
 * Team templates: the built-in ones plus saved ones in <workspace>/templates/<id>.json.
 * Saved files are validated on every load; a broken or hand-edited file that no longer passes is
 * skipped (and reported through `onSkip`), never half-applied.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TeamTemplate } from '@sebeto/shared';
import { slugify } from '../skills/store.js';
import { BUILTIN_IDS, BUILTIN_TEMPLATES } from './builtins.js';
import { parseTemplate } from './schema.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Saved template files larger than this are skipped (a valid one is far smaller). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class TemplateError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'builtin' | 'invalid' = 'invalid') {
    super(message);
    this.name = 'TemplateError';
  }
}

export interface TemplateStore {
  /** Built-in first, then saved ones by name. */
  list(): TeamTemplate[];
  get(id: string): TeamTemplate | undefined;
  /** Save a (validated) template; the id comes from its name (-2, -3… when taken); builtin is forced false. */
  save(template: TeamTemplate): TeamTemplate;
  /** Delete a saved template; built-in ones are refused. */
  remove(id: string): void;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createTemplateStore(workspaceDir: string, onSkip: (file: string, reason: string) => void = () => undefined): TemplateStore {
  const root = path.join(workspaceDir, 'templates');
  const fileOf = (id: string) => path.join(root, `${id}.json`);

  function readSaved(id: string): TeamTemplate | undefined {
    const file = fileOf(id);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return undefined;
      if (stat.size > MAX_FILE_BYTES) {
        onSkip(file, 'file too large');
        return undefined;
      }
      const t = parseTemplate(JSON.parse(fs.readFileSync(file, 'utf8')));
      // The file name is the id; a file can never pretend to be built in.
      return { ...t, id, builtin: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') onSkip(file, (err as Error).message.slice(0, 300));
      return undefined;
    }
  }

  function savedIds(): string[] {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name.slice(0, -'.json'.length))
        .filter((id) => ID_RE.test(id) && !BUILTIN_IDS.has(id));
    } catch {
      return [];
    }
  }

  return {
    list() {
      const saved = savedIds().map(readSaved).filter((t): t is TeamTemplate => !!t).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return [...BUILTIN_TEMPLATES.map(clone), ...saved];
    },
    get(id) {
      const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
      if (builtin) return clone(builtin);
      return ID_RE.test(id) ? readSaved(id) : undefined;
    },
    save(input) {
      const parsed = parseTemplate({ ...input, builtin: false });
      const base = slugify(parsed.name).slice(0, 56) || 'team';
      let id = base;
      for (let n = 2; BUILTIN_IDS.has(id) || fs.existsSync(fileOf(id)); n++) id = `${base}-${n}`;
      const t: TeamTemplate = { ...parsed, id, builtin: false };
      fs.mkdirSync(root, { recursive: true });
      const tmp = path.join(root, `.${id}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, fileOf(id));
      return t;
    },
    remove(id) {
      if (BUILTIN_IDS.has(id)) throw new TemplateError('Built-in templates cannot be deleted', 'builtin');
      if (!ID_RE.test(id) || !fs.existsSync(fileOf(id))) throw new TemplateError('Unknown template', 'not_found');
      fs.rmSync(fileOf(id), { force: true });
    },
  };
}
