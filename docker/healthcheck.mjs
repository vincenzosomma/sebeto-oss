// Container healthcheck: GET /api/v1/health with the API token (from SEBETO_TOKEN_FILE or SEBETO_TOKEN).
import { readFileSync } from 'node:fs';

let token = process.env.SEBETO_TOKEN?.trim();
if (!token && process.env.SEBETO_TOKEN_FILE) {
  try {
    token = readFileSync(process.env.SEBETO_TOKEN_FILE, 'utf8').trim();
  } catch {
    process.exit(1);
  }
}
const port = process.env.SEBETO_PORT || '7600';
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    headers: { authorization: `Bearer ${token ?? ''}` },
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
