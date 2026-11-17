#!/usr/bin/env node
/**
 * `npm start`: run Sebeto locally in any shell (PowerShell, cmd, bash).
 * Uses sensible defaults and prints the address to open, including the access token.
 *
 * Optional environment overrides: SEBETO_TOKEN, SEBETO_PORT, SEBETO_RUNTIMES, SEBETO_WORKSPACE,
 * SEBETO_OLLAMA_URL, SEBETO_OLLAMA_PIVOT_MODEL… They can also live in ~/.sebeto/sebeto.env (one SEBETO_NAME=value per
 * line, # comments), so they survive restarts; a variable set in the shell wins over the file.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreMain = path.join(root, 'packages', 'core', 'dist', 'main.js');
const uiDir = path.join(root, 'packages', 'ui', 'dist');

if (!existsSync(coreMain) || !existsSync(path.join(uiDir, 'index.html'))) {
  console.error('Sebeto is not built yet. Run:  npm install  and then  npm run build');
  process.exit(1);
}

// Settings file (only SEBETO_* names; the shell's own environment wins).
const envFile = path.join(os.homedir(), '.sebeto', 'sebeto.env');
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(SEBETO_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined && value !== '') process.env[m[1]] = value;
  }
}

const token = process.env.SEBETO_TOKEN || randomBytes(24).toString('hex');
const env = {
  ...process.env,
  SEBETO_TOKEN: token,
  SEBETO_PORT: process.env.SEBETO_PORT || '7600',
  SEBETO_RUNTIMES: process.env.SEBETO_RUNTIMES || 'mock,claude-cli,ollama,openai',
  SEBETO_UI_DIR: uiDir,
};

const child = spawn(process.execPath, [coreMain], { env, stdio: ['ignore', 'pipe', 'inherit'] });

child.stdout.on('data', (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.startsWith('SEBETO_READY ')) { if (line.trim()) console.log(line); continue; }
    const info = JSON.parse(line.slice('SEBETO_READY '.length));
    const url = `http://127.0.0.1:${info.port}/?token=${info.token}`;
    console.log('\n  Sebeto is running.');
    console.log(`  Open this address in your browser:\n\n    ${url}\n`);
    console.log('  Press Ctrl+C to stop.\n');
  }
});

const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
