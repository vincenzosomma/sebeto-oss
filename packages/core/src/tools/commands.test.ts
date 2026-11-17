import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildShellSpawn, commandEnv, defaultShell, runCommand } from './commands.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-cmd-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const shell = defaultShell();
const echo = (s: string) => (shell === 'powershell' ? `Write-Output '${s}'` : `echo ${s}`);

describe('runCommand', () => {
  it('runs a command in the given folder and captures output', async () => {
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'x');
    const list = shell === 'powershell' ? 'Get-ChildItem -Name' : 'ls';
    const r = await runCommand({ shell, command: `${echo('hello-sebeto')}; ${list}`, cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello-sebeto');
    expect(r.stdout).toContain('marker.txt');
    expect(r.timedOut).toBe(false);
  });

  it('reports a non-zero exit code', async () => {
    const r = await runCommand({ shell, command: 'exit 3', cwd: dir });
    expect(r.exitCode).toBe(3);
  });

  it('kills commands that exceed the timeout', async () => {
    const wait = shell === 'powershell' ? 'Start-Sleep -Seconds 20' : 'sleep 20';
    const r = await runCommand({ shell, command: wait, cwd: dir, timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(15000);
  }, 30000);

  it('does not expose Sebeto secrets to commands', async () => {
    process.env.SEBETO_TOKEN_TEST_LEAK = 'super-secret-value';
    try {
      expect(commandEnv().SEBETO_TOKEN_TEST_LEAK).toBeUndefined();
      const show = shell === 'powershell' ? 'Write-Output "v=$env:SEBETO_TOKEN_TEST_LEAK"' : 'echo "v=$SEBETO_TOKEN_TEST_LEAK"';
      const r = await runCommand({ shell, command: show, cwd: dir });
      expect(r.stdout).not.toContain('super-secret-value');
    } finally {
      delete process.env.SEBETO_TOKEN_TEST_LEAK;
    }
  });
});

describe('buildShellSpawn', () => {
  it('encodes PowerShell commands so quotes cannot break out', () => {
    const spec = buildShellSpawn('powershell', `Write-Output "a"; "b' ; rm -rf /`);
    expect(spec.file).toBe('powershell.exe');
    const encoded = spec.args[spec.args.indexOf('-EncodedCommand') + 1]!;
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(`Write-Output "a"; "b' ; rm -rf /`);
  });

  it('passes bash commands as a single argument', () => {
    expect(buildShellSpawn('bash', 'echo "$HOME"; ls').args).toEqual(['-c', 'echo "$HOME"; ls']);
  });
});
