#!/usr/bin/env node
// Records REAL Ollama /api/chat responses for the adapter contract tests
// (docs/15 Architecture Review #12, docs/09 Runtimes & Sessions "Contract fixtures").
//
// It runs the BUILT Ollama adapter (createOllamaAdapter) against the local Ollama server with a
// recording fetch, and a stand-in for Sebeto's tool server offering one tool. The model is asked
// a question it can only answer by calling the tool, so the recording holds the full loop:
// request 1 → tool call, request 2 (with the tool result) → final answer. Output:
//   src/runtimes/__fixtures__/ollama/tool-call.<ollamaVersion>.json
// ollama-contract.test.ts replays every such file through createOllamaAdapter with a fake fetch.
//
// Usage (Ollama running, model pulled; free, nothing leaves the computer):
//   npm run build -w @sebeto/shared && npm run build -w @sebeto/core
//   node packages/core/scripts/record-ollama-fixtures.mjs [--model qwen3-vl:4b-instruct] [--host http://127.0.0.1:11434]
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSIONS } from '@sebeto/shared';
import { assertClean, lf, redact } from './fixture-redact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDist = path.join(here, '..', 'dist', 'runtimes', 'ollama.js');
if (!existsSync(coreDist)) {
  console.error('Build the core first: npm run build -w @sebeto/shared && npm run build -w @sebeto/core');
  process.exit(1);
}
const { createOllamaAdapter } = await import(new URL(`file:///${coreDist.replace(/\\/g, '/')}`).href);

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const MODEL = opt('--model', 'qwen3-vl:4b-instruct');
const HOST = opt('--host', 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OUT_DIR = path.join(here, '..', 'src', 'runtimes', '__fixtures__', 'ollama');

async function getJson(p, body) {
  const res = await fetch(`${HOST}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return res.json();
}

let version;
try {
  version = (await getJson('/api/version')).version;
} catch {
  console.error(`Ollama is not reachable at ${HOST}. Start it and try again.`);
  process.exit(1);
}
const show = await getJson('/api/show', { model: MODEL });
if (show.error) {
  console.error(`Model ${MODEL}: ${show.error} (ollama pull ${MODEL})`);
  process.exit(1);
}
const capabilities = show.capabilities ?? [];
console.log(`Ollama ${version}, model ${MODEL} [${capabilities.join(', ')}]`);
if (!capabilities.includes('tools')) {
  console.error('This model has no tool support; pick one whose capabilities include "tools".');
  process.exit(1);
}

// A stand-in for Sebeto's MCP tool server (the adapter's ToolBridge seam): one IT Ops tool.
const TOOL = {
  name: 'get_free_disk_space',
  description: 'Return the free and total space of a Windows drive on the managed server.',
  inputSchema: { type: 'object', properties: { drive: { type: 'string', description: 'Drive letter, e.g. "C:"' } }, required: ['drive'] },
};
const TOOL_RESULT = 'Drive C: has 112 GB free of 476 GB (23% free).';
const SYSTEM_PROMPT = 'You are an IT Ops assistant. Answer in one short sentence.';
const PROMPT = 'How much free space is left on drive C: of the server? Use the tool to check, then tell me.';

async function recordOnce() {
  const exchanges = [];
  const toolCalls = [];
  const recordingFetch = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    let response;
    try {
      response = JSON.parse(text);
    } catch {
      response = { raw: text };
    }
    exchanges.push({ path: new URL(String(url)).pathname, request: init?.body ? JSON.parse(String(init.body)) : null, status: res.status, response });
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  const bridge = {
    tools: [TOOL],
    call: async (name, args) => {
      toolCalls.push({ name, args });
      return { text: TOOL_RESULT, isError: false };
    },
    close: async () => undefined,
  };
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'sebeto-ollama-fixtures-'));
  const events = [];
  try {
    const adapter = createOllamaAdapter({ baseUrl: HOST, fetchImpl: recordingFetch, connectTools: async () => bridge });
    for await (const e of adapter.run({
      ticketId: 'fixture', runId: 'fixture', newExternalSessionId: 'fixture-session', cwd, model: MODEL,
      systemPrompt: SYSTEM_PROMPT, prompt: PROMPT, permissions: { ...DEFAULT_PERMISSIONS }, budgetUsd: 0,
      mcp: { url: 'http://127.0.0.1:0/mcp', token: 'fixture' }, signal: new AbortController().signal,
    })) events.push(e);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return { exchanges, toolCalls, events };
}

let rec;
for (let attempt = 1; attempt <= 3; attempt++) {
  rec = await recordOnce();
  const chats = rec.exchanges.filter((x) => x.path === '/api/chat').length;
  console.log(`Attempt ${attempt}: ${chats} chat call(s), ${rec.toolCalls.length} tool call(s), events: ${rec.events.map((e) => e.kind).join(', ')}`);
  if (rec.toolCalls.length >= 1 && chats >= 2 && !rec.events.some((e) => e.kind === 'error')) break;
  if (attempt === 3) {
    console.error('The model did not complete a tool call + answer in 3 attempts; nothing saved.');
    process.exit(1);
  }
}

const fixture = {
  recordedWith: 'packages/core/scripts/record-ollama-fixtures.mjs',
  ollamaVersion: version,
  model: MODEL,
  capabilities,
  systemPrompt: SYSTEM_PROMPT,
  prompt: PROMPT,
  tools: [TOOL],
  toolResult: TOOL_RESULT,
  toolCalls: rec.toolCalls,
  exchanges: rec.exchanges,
  liveEvents: rec.events,
};
const text = lf(redact(JSON.stringify(fixture, null, 2)));
assertClean(text, 'ollama fixture');
mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `tool-call.${version}.json`);
writeFileSync(file, text, 'utf8');
console.log(`Saved ${path.relative(process.cwd(), file)}`);
