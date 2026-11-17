/**
 * Secret store for connector credentials (e.g. the Gmail app password).
 *
 * Rules (docs/23 Mail Connector.md):
 * - Secrets live in <workspace>/secrets/<name>.secret, never in the database, logs, API responses,
 *   prompts or ticket folders. Agents never see them: Sebeto's own tools use them on the agent's behalf.
 * - Windows: encrypted with DPAPI (CurrentUser scope), so only this Windows user on this computer
 *   can decrypt the file. The secret travels to PowerShell on stdin, never on a command line.
 * - Elsewhere (Linux/macOS/Docker): a file readable only by the owner (mode 600). For containers,
 *   mount the workspace on an encrypted volume. A macOS Keychain / libsecret backend can be added
 *   behind the same interface.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SecretStore {
  readonly kind: 'dpapi' | 'file';
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Turns plaintext into the bytes stored on disk and back. */
export interface Protector {
  readonly kind: 'dpapi' | 'file';
  protect(plain: Buffer): Promise<Buffer>;
  unprotect(stored: Buffer): Promise<Buffer>;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Run a PowerShell script with data on stdin; resolves with stdout. The script is passed encoded. */
function powershell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      // Never include stdin (the secret) in the error.
      else reject(new Error(`Windows could not ${script.includes('Unprotect') ? 'decrypt' : 'encrypt'} the secret (code ${code}). ${err.split(/\r?\n/)[0] ?? ''}`.trim()));
    });
    child.stdin.end(stdin, 'utf8');
  });
}

const DPAPI_PROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  "$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')",
  '[Convert]::ToBase64String($e)',
].join('; ');
const DPAPI_UNPROTECT = DPAPI_PROTECT.replace('::Protect(', '::Unprotect(');

export function dpapiProtector(): Protector {
  return {
    kind: 'dpapi',
    async protect(plain) {
      return Buffer.from(await powershell(DPAPI_PROTECT, plain.toString('base64')), 'base64');
    },
    async unprotect(stored) {
      return Buffer.from(await powershell(DPAPI_UNPROTECT, stored.toString('base64')), 'base64');
    },
  };
}

export function plainFileProtector(): Protector {
  return { kind: 'file', protect: async (b) => b, unprotect: async (b) => b };
}

export function defaultProtector(platform: NodeJS.Platform = process.platform): Protector {
  return platform === 'win32' ? dpapiProtector() : plainFileProtector();
}

export function createSecretStore(workspaceDir: string, protector: Protector = defaultProtector()): SecretStore {
  const dir = path.join(workspaceDir, 'secrets');
  const cache = new Map<string, string>();
  const fileOf = (name: string) => {
    if (!NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
    return path.join(dir, `${name}.secret`);
  };

  return {
    kind: protector.kind,
    async get(name) {
      const cached = cache.get(name);
      if (cached !== undefined) return cached;
      let stored: Buffer;
      try {
        stored = await fs.promises.readFile(fileOf(name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      const value = (await protector.unprotect(stored)).toString('utf8');
      cache.set(name, value);
      return value;
    },
    async set(name, value) {
      const file = fileOf(name);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const data = await protector.protect(Buffer.from(value, 'utf8'));
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data, { mode: 0o600 });
      await fs.promises.rename(tmp, file);
      cache.set(name, value);
    },
    async delete(name) {
      cache.delete(name);
      await fs.promises.rm(fileOf(name), { force: true });
    },
  };
}
