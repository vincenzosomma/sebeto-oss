// Fake `claude` used by contract tests: reads the prompt from stdin and prints a stream-json
// conversation. The text event echoes {args, stdin, files} so tests can assert what was passed.
// Prompt "hang" → prints init then waits forever (abort test).
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const sid = args[args.indexOf('--session-id') + 1] ?? args[args.indexOf('--resume') + 1];
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: 'system', subtype: 'init', session_id: sid, tools: ['Read'] });
  if (stdin.includes('hang')) {
    setInterval(() => undefined, 1000);
    return;
  }
  const spFile = args[args.indexOf('--append-system-prompt-file') + 1];
  const mcpIdx = args.indexOf('--mcp-config');
  const files = {
    systemPrompt: spFile && existsSync(spFile) ? readFileSync(spFile, 'utf8') : null,
    mcp: mcpIdx >= 0 ? JSON.parse(readFileSync(args[mcpIdx + 1], 'utf8')) : null,
  };
  out({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ args, stdin, files, cwd: process.cwd() }) }] } });
  // Split the result line across two writes to exercise partial-line handling.
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, usage: { input_tokens: 7, output_tokens: 3 } });
  process.stdout.write(result.slice(0, 20));
  setTimeout(() => process.stdout.write(`${result.slice(20)}\n`), 20);
});
