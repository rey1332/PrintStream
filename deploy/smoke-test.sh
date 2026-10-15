#!/bin/sh
# Checks a running ETNA end to end: health, sign-in, the session, and a data
# request through row-level security. Used by CI for the Linux installs; also
# handy after an update.
#
#   deploy/smoke-test.sh http://127.0.0.1:4028 you@example.com 'password'
set -eu

BASE=${1:?usage: smoke-test.sh base-url email password}
EMAIL=${2:?usage: smoke-test.sh base-url email password}
PASSWORD=${3:?usage: smoke-test.sh base-url email password}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
ORIGIN="Origin: $BASE"

fail() { echo "FAILED: $*" >&2; exit 1; }

curl -fsS "$BASE/api/health" | grep -q '"database":"ok"' || fail "health"
echo "ok   health"

# The password goes in the request body only (never in a URL or the process list of the server).
body=$(EMAIL="$EMAIL" PASSWORD="$PASSWORD" node -e 'process.stdout.write(JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }))')
printf '%s' "$body" | curl -fsS -c "$JAR" -H "$ORIGIN" -H 'Content-Type: application/json' --data-binary @- "$BASE/api/auth/login" >/dev/null ||
  fail "sign-in"
echo "ok   sign-in"

curl -fsS -b "$JAR" "$BASE/api/auth/session" | grep -q "\"email\":\"$EMAIL\"" || fail "session"
echo "ok   session"

curl -fsS -b "$JAR" -H "$ORIGIN" -H 'Content-Type: application/json' \
  --data '{"kind":"rpc","fn":"erp_my_workspaces","args":{}}' "$BASE/api/data" | grep -q '"error":null' ||
  fail "data request"
echo "ok   data request"

code=$(curl -s -o /dev/null -w '%{http_code}' -b 'etna_session=made-up' "$BASE/api/erp/workspace")
[ "$code" = 401 ] || fail "a made-up session cookie got $code, not 401"
echo "ok   a made-up session is refused"
