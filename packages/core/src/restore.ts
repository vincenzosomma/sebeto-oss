#!/usr/bin/env node
/**
 * Restore a Sebeto backup into a NEW workspace folder, or verify one (v0.7 Q). See backup/cli.ts.
 *   node packages/core/dist/restore.js <backup.zip> <newWorkspaceFolder> [--passphrase-file <file>]
 *   node packages/core/dist/restore.js --verify <backup.zip> [--passphrase-file <file>]
 */
import { readFileSync } from 'node:fs';
import { runRestoreCli } from './backup/cli.js';

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

runRestoreCli(process.argv.slice(2), {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
}, { appVersion: version() }).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`Restore failed: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  },
);
