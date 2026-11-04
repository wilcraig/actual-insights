#!/usr/bin/env bash
# End-to-end smoke test of the all-in-one image against a SYNTHETIC budget. Needs Docker, curl, python3, node.
#   all-in-one/test/smoke.sh [--build] [image]        (run from anywhere; --build builds the image first)
# Leaves one Docker volume behind and prints the command to remove it. Never touches real data.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE="actual-insights-aio:dev"; BUILD=0
for a in "$@"; do case "$a" in --build) BUILD=1;; *) IMAGE="$a";; esac; done
PORT="${SMOKE_PORT:-5190}"; PW="smoke-password-$RANDOM"; NAME="aio-smoke-$$"; VOL="aio-smoke-data-$$"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
wait_healthy() { local i s; for i in $(seq 1 60); do s=$(docker inspect "$NAME" --format '{{.State.Health.Status}}' 2>/dev/null); [ "$s" = healthy ] && return 0; sleep 2; done; return 1; }
start() { docker run -d --rm --name "$NAME" -p "$PORT:5006" -v "$VOL:/data" -e TZ=America/Denver "$@" "$IMAGE" >/dev/null; }
stop_c() { docker stop "$NAME" >/dev/null 2>&1; }
trap 'stop_c' EXIT
killproc() { docker exec "$NAME" sh -c "for d in /proc/[0-9]*; do if tr '\\0' ' ' < \$d/cmdline 2>/dev/null | grep -q '$1'; then kill -9 \${d#/proc/}; fi; done"; }
json() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

[ "$BUILD" = 1 ] && { echo "== build"; docker build -f "$ROOT/all-in-one/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null || { echo "build failed"; exit 1; }; }
docker volume create "$VOL" >/dev/null

echo "== first start (no Insights settings yet)"
start; wait_healthy && ok "container healthy" || { bad "container healthy"; exit 1; }
check "GET /health" "$(curl -s localhost:$PORT/health)" '{"status":"UP"}'
check "GET /info through the proxy" "$(curl -s localhost:$PORT/info | json "d['build']['name']")" '@actual-app/sync-server'
HTML="$(curl -s localhost:$PORT/)"
case "$HTML" in *'/insights/bundle.js'*) ok "Insights bundle tag injected";; *) bad "Insights bundle tag injected";; esac
check "Insights bundle served" "$(code localhost:$PORT/insights/bundle.js)" 200
check "summary without a token is 401" "$(code localhost:$PORT/api/mobile/summary)" 401
curl -s -D - -o /dev/null localhost:$PORT/api/mobile/summary | grep -qi '^www-authenticate: Bearer realm="actual-insights"' && ok "401 carries the bearer challenge" || bad "401 carries the bearer challenge"
case "$HTML" in *'/abt/browser-shim.js'*) echo "  info ABT layer is on";; *) echo "  info ABT layer is off";; esac

echo "== bootstrap and seed a synthetic budget"
curl -s -X POST localhost:$PORT/account/bootstrap -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" | grep -q '"status":"ok"' && ok "server password set" || bad "server password set"
docker cp "$HERE/seed.js" "$NAME:/tmp/seed.js"
SEED_OUT="$(docker exec -e SEED_PASSWORD="$PW" -e NODE_PATH=/opt/insights/api/node_modules "$NAME" node /tmp/seed.js 2>&1)"
SID="$(echo "$SEED_OUT" | sed -n 's/^SYNC_ID=//p' | head -1)"
[ -n "$SID" ] && ok "demo budget seeded and synced" || { bad "demo budget seeded ($(echo "$SEED_OUT" | tail -2 | tr '\n' ' '))"; exit 1; }

echo "== restart with Insights settings"
stop_c; sleep 2
start -e ACTUAL_SERVER_PASSWORD="$PW" -e ACTUAL_SYNC_ID="$SID"; wait_healthy && ok "healthy with Insights configured" || { bad "healthy with Insights configured"; exit 1; }
SESSION="$(curl -s -X POST localhost:$PORT/account/login -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" | json "d['data']['token']")"
CREATED="$(curl -s -X POST localhost:$PORT/api/mobile/tokens -H "X-ACTUAL-TOKEN: $SESSION" -H 'Content-Type: application/json' -d '{"label":"smoke"}')"
TOKEN="$(echo "$CREATED" | json "d['token']")"; TID="$(echo "$CREATED" | json "d['id']")"
check "device token is 43 characters" "${#TOKEN}" 43
check "summary with the device token" "$(code -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/mobile/summary)" 200
curl -s -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/mobile/summary > /tmp/aio-smoke-summary.json
node -e '
const d=JSON.parse(require("fs").readFileSync("/tmp/aio-smoke-summary.json","utf8"));
const bad=[]; const need=["schema","generatedAt","currency","month","projection","accounts","upcoming","forecast","goals"];
for (const k of need) if (!(k in d)) bad.push("missing "+k);
if (d.schema!==1) bad.push("schema");
if (!/^[A-Z]{3}$/.test(d.currency)) bad.push("currency");
if (!Array.isArray(d.accounts)||d.accounts.length<1) bad.push("accounts");
for (const a of d.accounts||[]) if (!Number.isInteger(a.balance)) bad.push("balance not integer cents");
if (d.month && !Number.isInteger(d.month.remaining)) bad.push("remaining");
process.exit(bad.length?(console.error(bad.join("; ")),1):0)' && ok "summary matches the contract (shape and integer cents)" || bad "summary matches the contract"
check "no CORS headers on the summary" "$(curl -s -D - -o /dev/null -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/mobile/summary | grep -ci '^access-control')" 0
check "Actual session token refused on the summary" "$(code -H "Authorization: Bearer $SESSION" localhost:$PORT/api/mobile/summary)" 401
check "device token refused on token management" "$(code -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/mobile/tokens)" 401
check "Insights chart route with a session token" "$(code -H "X-ACTUAL-TOKEN: $SESSION" localhost:$PORT/api/accounts)" 200

echo "== supervision"
killproc 'insights/api/src/serve[r].js'; sleep 5
check "summary works after the API is killed and restarted" "$(code -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/mobile/summary)" 200
killproc 'insights/proxy/src/serve[r].js'; sleep 5
check "public port works after the proxy is killed and restarted" "$(code localhost:$PORT/health)" 200
if curl -s localhost:$PORT/ | grep -q '/abt/browser-shim.js'; then
  killproc 'abt/server[.]js'; sleep 5
  check "page still serves after ABT is killed and restarted" "$(code localhost:$PORT/)" 200
fi

echo "== persistence and revocation"
stop_c; sleep 2
start -e ACTUAL_SERVER_PASSWORD="$PW" -e ACTUAL_SYNC_ID="$SID"; wait_healthy && ok "healthy after a restart on the same volume" || bad "healthy after a restart"
check "device token survives a restart" "$(code -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/mobile/summary)" 200
SESSION="$(curl -s -X POST localhost:$PORT/account/login -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" | json "d['data']['token']")"
check "revoke returns 204" "$(code -X DELETE -H "X-ACTUAL-TOKEN: $SESSION" localhost:$PORT/api/mobile/tokens/$TID)" 204
check "revoked token is refused at once" "$(code -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/mobile/summary)" 401
T0=$(date +%s); stop_c; T1=$(date +%s)
[ $((T1-T0)) -le 8 ] && ok "graceful stop in $((T1-T0))s" || bad "graceful stop took $((T1-T0))s"

echo; echo "passed $PASS, failed $FAIL"
echo "cleanup: docker volume rm $VOL"
[ "$FAIL" = 0 ]
