// Stand-in `claude` for the contract tests: waits for the prompt on stdin (like the real CLI),
// then prints a recorded stream-json fixture in uneven chunks.
// Usage: node replay-claude.mjs <fixture.jsonl> [claude arguments…]
import { readFileSync } from 'node:fs';

const text = readFileSync(process.argv[2], 'utf8');
process.stdin.resume();
process.stdin.on('end', () => {
  let i = 0;
  const step = () => {
    if (i >= text.length) return;
    process.stdout.write(text.slice(i, i + 997), step);
    i += 997;
  };
  step();
});
