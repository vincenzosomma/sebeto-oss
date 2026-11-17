/**
 * Command line restore / verify (v0.7 Q). Used by ../restore.ts:
 *
 *   node packages/core/dist/restore.js <backup.zip> <targetDir> [--passphrase-file <file>]
 *   node packages/core/dist/restore.js --verify <backup.zip> [--passphrase-file <file>]
 *
 * Restore never writes into an existing workspace: <targetDir> must be new or empty. The passphrase
 * is read from a file (never from the command line, where other users could see it) and never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { restoreBackupFile, verifyBackupFile, BackupError } from './archive.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  'Usage:',
  '  node packages/core/dist/restore.js <backup.zip> <newWorkspaceFolder> [--passphrase-file <file>]',
  '  node packages/core/dist/restore.js --verify <backup.zip> [--passphrase-file <file>]',
  '',
  'The new workspace folder must not exist yet (or be empty): a restore never overwrites a workspace.',
  'The passphrase (only needed for backups that include secrets) is read from a file, never typed on the command line.',
];

/** Reads the passphrase file: the first line, without the line break. */
export function readPassphraseFile(file: string): string {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return raw.split(/\r?\n/)[0] ?? '';
}

export function startInstructions(target: string): string[] {
  return [
    'Start Sebeto on the restored workspace (the old one is untouched):',
    `  PowerShell:  $env:SEBETO_WORKSPACE = "${target}"; npm start`,
    `  bash/zsh:    SEBETO_WORKSPACE="${target}" npm start`,
    `  or:          node packages/core/dist/main.js --workspace "${target}"`,
    '  Desktop app: set the SEBETO_WORKSPACE environment variable for your user to that folder, then start Sebeto.',
    'Stop the Sebeto that uses the old workspace first if you want to switch for good. An older database is upgraded on first start.',
  ];
}

/** Returns the process exit code (0 ok, 1 failed, 2 usage). */
export async function runRestoreCli(argv: string[], io: CliIo, opts: { appVersion?: string } = {}): Promise<number> {
  const args: string[] = [];
  let passFile: string | undefined;
  let verifyOnly = false;
  const usage = (to: (l: string) => void) => { for (const l of USAGE) to(l); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--passphrase-file') {
      passFile = argv[++i];
      if (!passFile) { usage(io.err); return 2; }
    } else if (a.startsWith('--passphrase-file=')) passFile = a.slice('--passphrase-file='.length);
    else if (a === '--verify' || a === '--verify-only') verifyOnly = true;
    else if (a === '--help' || a === '-h') { usage(io.out); return 0; }
    else if (a.startsWith('--')) { io.err(`Unknown option ${a}`); usage(io.err); return 2; }
    else args.push(a);
  }
  if (args.length !== (verifyOnly ? 1 : 2)) { usage(io.err); return 2; }
  let passphrase: string | undefined;
  if (passFile !== undefined) {
    try {
      passphrase = readPassphraseFile(passFile);
    } catch (err) {
      io.err(`Cannot read the passphrase file (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
      return 1;
    }
  }
  const backup = path.resolve(args[0]!);
  if (!fs.existsSync(backup)) { io.err(`Backup not found: ${backup}`); return 1; }

  if (verifyOnly) {
    const { result } = await verifyBackupFile(backup, { passphrase });
    if (result.ok) {
      io.out(`OK: ${result.files} files intact, schema v${result.schemaVersion} (this Sebeto supports up to v${result.supportedSchemaVersion}), made ${result.createdAt ?? '?'}.`);
      if (result.includesSecrets) io.out(result.secretsOpened ? 'Encrypted secrets: the passphrase opens them.' : 'Encrypted secrets: present (give --passphrase-file to check the passphrase).');
      return 0;
    }
    io.err('FAILED verification:');
    for (const p of result.problems) io.err(`  - ${p}`);
    return 1;
  }

  try {
    const r = await restoreBackupFile(backup, args[1]!, { passphrase, appVersion: opts.appVersion });
    io.out(`Restored ${r.files} files into ${r.targetDir} (database schema v${r.schemaVersion}${r.migratedTo !== r.schemaVersion ? `, upgraded to v${r.migratedTo}` : ''}; ${r.secretsRestored} secrets; ${r.ticketFoldersMoved} ticket folder paths updated).`);
    for (const w of r.warnings) io.out(`Note: ${w}`);
    io.out('');
    for (const l of startInstructions(r.targetDir)) io.out(l);
    return 0;
  } catch (err) {
    io.err(err instanceof BackupError ? err.message : `Restore failed: ${(err as Error).message}`);
    return 1;
  }
}
