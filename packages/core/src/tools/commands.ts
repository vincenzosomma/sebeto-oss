/**
 * Command execution for the `run_command` tool.
 *
 * Threat model (docs/15 Architecture Review.md item 3): a command can touch the whole machine,
 * so it is only ever run AFTER the owner approved this exact command (permission gate, key
 * `script.run` or `prod.change`). This module only executes; it never decides.
 *
 * Safety measures here:
 * - No shell string interpolation of our own: the command is handed to the chosen shell as ONE
 *   argument (PowerShell via -EncodedCommand, so quoting can't break out).
 * - Sebeto's own secrets (SEBETO_* env vars, e.g. the API token) are removed from the environment.
 * - Hard timeout; on Windows the whole process tree is killed (taskkill /T), elsewhere the group.
 * - Output is capped so a chatty command can't exhaust memory.
 */
import { spawn, spawnSync } from 'node:child_process';

export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'sh';

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 600;
/** Max bytes kept per stream (stdout / stderr). */
export const OUTPUT_MAX_BYTES = 256 * 1024;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export function defaultShell(platform: NodeJS.Platform = process.platform): ShellKind {
  return platform === 'win32' ? 'powershell' : 'bash';
}

export function shellsFor(platform: NodeJS.Platform = process.platform): ShellKind[] {
  return platform === 'win32' ? ['powershell', 'cmd'] : ['bash', 'sh'];
}

/** Build the program + arguments for a shell. Pure; exported for tests. */
export function buildShellSpawn(shell: ShellKind, command: string): { file: string; args: string[]; verbatim: boolean } {
  switch (shell) {
    case 'powershell': {
      // -EncodedCommand takes base64 of UTF-16LE: the command text never goes through argument quoting.
      const encoded = Buffer.from(command, 'utf16le').toString('base64');
      return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], verbatim: false };
    }
    case 'cmd':
      // /d: no AutoRun; /s /c "<command>": cmd strips exactly the outer quotes.
      return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
    case 'bash':
      return { file: 'bash', args: ['-c', command], verbatim: false };
    case 'sh':
      return { file: '/bin/sh', args: ['-c', command], verbatim: false };
  }
}

/** Environment for commands: everything except Sebeto's own secrets/config. */
export function commandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^SEBETO_/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

export function runCommand(input: { shell: ShellKind; command: string; cwd: string; timeoutSec?: number; signal?: AbortSignal }): Promise<CommandResult> {
  const timeoutSec = Math.min(Math.max(1, input.timeoutSec ?? DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC);
  const spec = buildShellSpawn(input.shell, input.command);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, {
      cwd: input.cwd,
      env: commandEnv(),
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      detached: process.platform !== 'win32', // own process group so the whole tree can be killed
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const append = (cur: Buffer, chunk: Buffer): Buffer => {
      if (cur.length >= OUTPUT_MAX_BYTES) { truncated = true; return cur; }
      const room = OUTPUT_MAX_BYTES - cur.length;
      if (chunk.length > room) truncated = true;
      return Buffer.concat([cur, chunk.subarray(0, room)]);
    };
    child.stdout?.on('data', (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr?.on('data', (c: Buffer) => { stderr = append(stderr, c); });

    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutSec * 1000);
    const onAbort = () => killTree(child.pid);
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, extraErr = '') => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8') + extraErr,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (err) => finish(null, `\nCould not start ${spec.file}: ${err.message}`));
    child.on('close', (code) => finish(code));
  });
}
