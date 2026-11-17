#!/usr/bin/env bash
# Smoke test for a packaged Sebeto build (used by CI on Linux and macOS).
#
#   apps/desktop/scripts/smoke-health.sh <label> <command> [args...]
#
# Runs <command> (the packaged core under ELECTRON_RUN_AS_NODE, or the whole app) with a fresh
# temporary workspace and the mock runtime, waits for the core's `SEBETO_READY {...}` line on
# stdout, then checks GET /api/v1/health (with the printed token) and that the UI's index.html is
# served at /. The process is stopped afterwards; exit code 0 means everything answered.
set -euo pipefail

label="$1"
shift
work="$(mktemp -d)"
log="$work/output.log"
export SEBETO_WORKSPACE="$work/workspace"
export SEBETO_RUNTIMES=mock
export SEBETO_HOST=127.0.0.1
export SEBETO_PORT=0 # random free port (the desktop app sets this itself)

echo "smoke[$label]: $*"
# Job control: the command gets its own process group, so stop() also ends whatever it spawned
# (the AppImage runtime starts Electron as a child; a leftover Electron would hold the app's
# single-instance lock and make the next launch exit at once).
set -m
"$@" >"$log" 2>&1 &
pid=$!
set +m

stop() {
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 -- "-$pid" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
fail() {
  echo "smoke[$label]: FAILED: $1"
  echo "----- output -----"
  cat "$log" || true
  stop
  exit 1
}

ready=""
for _ in $(seq 1 120); do
  ready="$(grep -m1 -o 'SEBETO_READY {.*}' "$log" || true)"
  [ -n "$ready" ] && break
  kill -0 "$pid" 2>/dev/null || fail "process exited before the core was ready"
  sleep 0.5
done
[ -n "$ready" ] || fail "no SEBETO_READY line within 60 s"

json="${ready#SEBETO_READY }"
port="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).port))')"
token="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')"
echo "smoke[$label]: core ready on 127.0.0.1:$port"

health="$(curl -fsS -H "Authorization: Bearer $token" "http://127.0.0.1:$port/api/v1/health")" || fail "GET /api/v1/health failed"
echo "smoke[$label]: /api/v1/health -> $health"
printf '%s' "$health" | grep -q '"ok":true' || fail "health did not report ok"

curl -fsS "http://127.0.0.1:$port/" | grep -qi '<!doctype html' || fail "GET / did not serve the UI's index.html"
echo "smoke[$label]: / serves the UI"

stop
echo "smoke[$label]: OK"
