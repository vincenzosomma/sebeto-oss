/**
 * Core configuration from environment variables (and optional CLI flags).
 * See docs/14 Deployment Modes.md and docs/15 Architecture Review.md (item 5).
 *
 * Env:
 *   SEBETO_WORKSPACE     workspace root (default ~/.sebeto/workspace)
 *   SEBETO_HOST          bind host (default 127.0.0.1)
 *   SEBETO_PORT          port (default 7600; 0 = random free port)
 *   SEBETO_TOKEN         API bearer token (default: random 32-byte hex per launch)
 *   SEBETO_TOKEN_FILE    read the token from a file (Docker secrets); used when SEBETO_TOKEN is unset
 *   SEBETO_UI_DIR        built UI to serve (optional)
 *   SEBETO_MAX_PARALLEL  max concurrent runs (default 3)
 *   SEBETO_RUNTIMES      enabled runtimes, comma separated (default mock,claude-cli,codex-cli,ollama,openai; openai = the AI connections)
 *   SEBETO_ALLOWED_HOSTS extra Host header names accepted (comma separated; DNS-rebinding defence)
 *
 * CLI flags (override env): --workspace, --host, --port, --token-file, --ui-dir, --max-parallel, --runtimes
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CoreConfig } from './contracts.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** CoreConfig plus settings only the API/shell layer needs. */
export interface SebetoConfig extends CoreConfig {
  /** Whether the token came from SEBETO_TOKEN / SEBETO_TOKEN_FILE (vs generated). */
  tokenProvided: boolean;
  /** Extra accepted Host header names (besides loopback names and the bind host). */
  allowedHosts: string[];
}

export const DEFAULT_PORT = 7600;
export const MIN_TOKEN_LENGTH = 16;

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when a bind host / hostname only reaches this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOOPBACK_NAMES.has(h)) return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

type Env = Record<string, string | undefined>;

function parseArgv(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i++;
      } else {
        out[arg.slice(2)] = 'true';
      }
    }
  }
  return out;
}

function nonEmpty(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function parseIntIn(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number (got "${raw}")`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

function readVersion(): string {
  try {
    // src/config.ts and dist/config.js both sit one level below packages/core/package.json
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(env: Env = process.env, argv: readonly string[] = process.argv.slice(2)): SebetoConfig {
  const args = parseArgv(argv);
  const pick = (flag: string, envName: string) => nonEmpty(args[flag]) ?? nonEmpty(env[envName]);

  const workspaceDir = resolve(expandHome(pick('workspace', 'SEBETO_WORKSPACE') ?? join(homedir(), '.sebeto', 'workspace')));
  const host = pick('host', 'SEBETO_HOST') ?? '127.0.0.1';
  const portRaw = pick('port', 'SEBETO_PORT');
  const port = portRaw === undefined ? DEFAULT_PORT : parseIntIn('SEBETO_PORT', portRaw, 0, 65535);

  let apiToken = nonEmpty(env.SEBETO_TOKEN);
  if (apiToken === undefined) {
    const tokenFile = pick('token-file', 'SEBETO_TOKEN_FILE');
    if (tokenFile !== undefined) {
      try {
        apiToken = nonEmpty(readFileSync(tokenFile, 'utf8'));
      } catch (err) {
        throw new ConfigError(`Cannot read SEBETO_TOKEN_FILE (${tokenFile}): ${(err as Error).message}`);
      }
      if (apiToken === undefined) throw new ConfigError(`SEBETO_TOKEN_FILE (${tokenFile}) is empty`);
    }
  }
  const tokenProvided = apiToken !== undefined;
  if (apiToken !== undefined && apiToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`The API token must be at least ${MIN_TOKEN_LENGTH} characters long`);
  }
  if (!isLoopbackHost(host) && !tokenProvided) {
    throw new ConfigError(
      `Refusing to listen on ${host} without an explicit token. Set SEBETO_TOKEN or SEBETO_TOKEN_FILE, or bind to 127.0.0.1.`,
    );
  }
  apiToken ??= randomBytes(32).toString('hex');

  const uiDirRaw = pick('ui-dir', 'SEBETO_UI_DIR');
  const maxRaw = pick('max-parallel', 'SEBETO_MAX_PARALLEL');
  const maxParallelRuns = maxRaw === undefined ? 3 : parseIntIn('SEBETO_MAX_PARALLEL', maxRaw, 1, 64);
  const runtimes = (pick('runtimes', 'SEBETO_RUNTIMES') ?? 'mock,claude-cli,codex-cli,ollama,openai')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (runtimes.length === 0) throw new ConfigError('SEBETO_RUNTIMES must list at least one runtime');
  const allowedHosts = (nonEmpty(env.SEBETO_ALLOWED_HOSTS) ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const config: SebetoConfig = {
    workspaceDir,
    host,
    port,
    apiToken,
    maxParallelRuns,
    runtimes,
    version: readVersion(),
    tokenProvided,
    allowedHosts,
  };
  if (uiDirRaw !== undefined) config.uiDir = resolve(uiDirRaw);
  return config;
}
