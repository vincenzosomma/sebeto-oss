#!/usr/bin/env node
// Records REAL `claude -p --output-format stream-json` output for the adapter contract tests
// (docs/15 Architecture Review #12, docs/09 Runtimes & Sessions "Contract fixtures").
//
// It runs the installed Claude Code CLI exactly like the claude-cli adapter does (same
// buildClaudeArgs / buildSpawnSpec / buildMcpConfig from the BUILT core, prompt on stdin,
// system prompt in a file, Sebeto-style MCP server) for a few tiny scenarios, and writes the raw
// stream-json lines, redacted, to:
//   src/runtimes/__fixtures__/claude/<scenario>.<claudeVersion>.jsonl
//   src/runtimes/__fixtures__/claude/version.<claudeVersion>.txt   (raw `claude --version`)
// claude-contract.test.ts picks up every version automatically.
//
// Usage (from the repo root, Claude Code installed and signed in):
//   npm run build -w @sebeto/shared && npm run build -w @sebeto/core
//   node packages/core/scripts/record-claude-fixtures.mjs [--max-total-usd 0.30] [--only plain,mcp-echo]
//
// Costs real money (model haiku, each run capped by --max-budget-usd). The script prints the cost
// of every run and refuses to start a run that could push the total over --max-total-usd.
// Claude runs in a fresh temp folder, never in a Sebeto workspace.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { DEFAULT_PERMISSIONS } from '@sebeto/shared';
import { assertClean, lf, redact } from './fixture-redact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDist = path.join(here, '..', 'dist', 'runtimes', 'claude-cli.js');
if (!existsSync(coreDist)) {
  console.error('Build the core first: npm run build -w @sebeto/shared && npm run build -w @sebeto/core');
  process.exit(1);
}
const { buildClaudeArgs, buildMcpConfig, buildSpawnSpec, childEnv, parseClaudeVersion, resolveClaudeCommand } = await import(new URL(`file:///${coreDist.replace(/\\/g, '/')}`).href);

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const MAX_TOTAL = Number(opt('--max-total-usd', '0.30'));
const ONLY = opt('--only', '')?.split(',').filter(Boolean) ?? [];
/** Per-run cap passed as --max-budget-usd (the adapter's budgetUsd). */
const RUN_BUDGET = 0.05;
const MODEL = 'haiku';
const OUT_DIR = path.join(here, '..', 'src', 'runtimes', '__fixtures__', 'claude');

// ------------------------------------------------------------------ claude command

const resolved = resolveClaudeCommand({
  platform: process.platform,
  pathEnv: process.env.PATH ?? process.env.Path ?? '',
  fileExists: (p) => existsSync(p),
  nodePath: process.execPath,
  comSpec: process.env.ComSpec,
});
if (!resolved) {
  console.error('Claude Code is not installed (claude not found on PATH).');
  process.exit(1);
}

function runProcess(args, { cwd, stdin = '' } = {}) {
  const spec = buildSpawnSpec(resolved, args);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(spec.command),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin, 'utf8');
  });
}

const versionOut = (await runProcess(['--version'])).stdout.trim();
const version = parseClaudeVersion(versionOut);
if (!version) {
  console.error(`Could not read the Claude Code version from: ${versionOut}`);
  process.exit(1);
}
console.log(`Claude Code ${version} (${versionOut})`);

// ------------------------------------------------------------------ a tiny Sebeto-like MCP server

const mcpToken = randomBytes(32).toString('hex');
const echoCalls = [];
const http = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${mcpToken}`) {
    res.writeHead(401).end();
    return;
  }
  // Stateless, like Sebeto's own tool server: a fresh server + transport per request.
  const server = new McpServer({ name: 'sebeto', version: '0.0.0-fixture' });
  server.registerTool('echo', {
    description: 'Echo the given text back. Used to test tool calls.',
    inputSchema: { text: z.string().describe('Text to echo back') },
  }, async ({ text }) => {
    echoCalls.push(text);
    return { content: [{ type: 'text', text: `echo: ${text}` }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const mcp = { url: `http://127.0.0.1:${http.address().port}/mcp`, token: mcpToken };

// ------------------------------------------------------------------ one adapter-identical run

const work = mkdtempSync(path.join(os.tmpdir(), 'sebeto-claude-fixtures-'));
const sebetoDir = path.join(work, '.sebeto');
mkdirSync(sebetoDir, { recursive: true });
let total = 0;
let runs = 0;

async function claudeRun({ prompt, systemPrompt = 'You are a test agent. Be brief.', model = MODEL, budgetUsd = RUN_BUDGET, newSession, resume, withMcp = false }) {
  if (total + budgetUsd > MAX_TOTAL + 1e-9) {
    throw new Error(`Stopping: this run (cap $${budgetUsd}) could push the total ($${total.toFixed(4)}) over $${MAX_TOTAL.toFixed(2)}.`);
  }
  const tag = `fx${++runs}`;
  const systemPromptFile = path.join(sebetoDir, `run-${tag}-system.md`);
  const mcpConfigFile = withMcp ? path.join(sebetoDir, `run-${tag}-mcp.json`) : undefined;
  writeFileSync(systemPromptFile, systemPrompt, 'utf8');
  if (mcpConfigFile) writeFileSync(mcpConfigFile, buildMcpConfig(mcp), { encoding: 'utf8', mode: 0o600 });
  const args = buildClaudeArgs({
    externalSessionId: resume, newExternalSessionId: newSession, model, budgetUsd,
    permissions: { ...DEFAULT_PERMISSIONS }, mcp: withMcp ? mcp : undefined,
  }, { systemPromptFile, mcpConfigFile });
  // The adapter never passes less than $0.01; the budget scenario goes lower on purpose so the
  // cap trips after the first model call (cheap and deterministic).
  if (budgetUsd < 0.01) args[args.indexOf('--max-budget-usd') + 1] = String(budgetUsd);
  const { code, stdout, stderr } = await runProcess(args, { cwd: work, stdin: prompt });
  rmSync(systemPromptFile, { force: true });
  if (mcpConfigFile) rmSync(mcpConfigFile, { force: true });

  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  let cost = 0;
  let result;
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o.type === 'result') {
        result = o;
        cost = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : 0;
      }
    } catch { /* not JSON: kept as-is, the parser must cope */ }
  }
  total += cost;
  console.log(`  exit ${code}, ${lines.length} lines, result ${result ? `${result.subtype} is_error=${result.is_error}` : 'MISSING'}, cost $${cost.toFixed(5)} (total $${total.toFixed(5)})`);
  if (!result && stderr.trim()) console.log(`  stderr: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  return { lines, result };
}

function save(scenario, lines) {
  const extra = [
    [JSON.stringify(work).slice(1, -1), '<tmp>'], // JSON-escaped Windows path
    [work, '<tmp>'],
    [work.replace(/[^A-Za-z0-9]/g, '-'), '<tmp-project>'], // ~/.claude/projects/<mangled cwd>
    [mcp.url, 'http://127.0.0.1:<port>/mcp'],
    [mcpToken, '<token>'],
  ];
  const text = lf(lines.map((l) => redact(l, extra)).join('\n'));
  assertClean(text, scenario);
  const file = path.join(OUT_DIR, `${scenario}.${version}.jsonl`);
  writeFileSync(file, text, 'utf8');
  console.log(`  saved ${path.relative(process.cwd(), file)}`);
}

// ------------------------------------------------------------------ scenarios

const scenarios = {
  // a. plain answer
  async plain() {
    const { lines } = await claudeRun({ prompt: 'Reply with exactly: ok', newSession: randomUUID() });
    save('plain', lines);
  },
  // b. a session resumed with --resume
  async resume() {
    const sid = randomUUID();
    const first = await claudeRun({ prompt: 'Remember this change ticket code: VESUVIO. Reply with exactly: ok', newSession: sid });
    save('resume-start', first.lines);
    const second = await claudeRun({ prompt: 'What was the change ticket code? Reply with just the code.', resume: sid });
    save('resume-continue', second.lines);
  },
  // c. one call to a Sebeto MCP tool
  async 'mcp-echo'() {
    const before = echoCalls.length;
    const { lines } = await claudeRun({
      prompt: 'Call the echo tool exactly once with the text "ping", then reply with exactly what it returned.',
      newSession: randomUUID(), withMcp: true,
    });
    console.log(`  MCP server received ${echoCalls.length - before} echo call(s)`);
    save('mcp-echo', lines);
  },
  // d. errors: an unknown model (no tokens spent), and the budget cap reached on a long answer
  async 'error-invalid-model'() {
    const { lines } = await claudeRun({ prompt: 'Reply with exactly: ok', model: 'claude-no-such-model-0', newSession: randomUUID(), budgetUsd: 0.01 });
    save('error-invalid-model', lines);
  },
  async 'error-budget'() {
    const { lines } = await claudeRun({
      prompt: 'Call the echo tool three times, one call at a time, with "disk", "cpu" and "memory". Then summarise the results.',
      newSession: randomUUID(), withMcp: true, budgetUsd: 0.001,
    });
    save('error-budget', lines);
  },
};

writeFileSync(path.join(OUT_DIR, `version.${version}.txt`), lf(versionOut), 'utf8');
try {
  for (const [name, fn] of Object.entries(scenarios)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    console.log(`Scenario ${name}`);
    await fn();
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  http.close();
  rmSync(work, { recursive: true, force: true });
  console.log(`Total real spend: $${total.toFixed(5)}`);
}
