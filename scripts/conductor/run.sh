#!/usr/bin/env bash
set -euo pipefail

if [[ "${CONDUCTOR_IS_LOCAL:-0}" != "1" ]]; then
  echo "The development server requires a local Conductor workspace and Docker." >&2
  exit 1
fi
if [[ ! "${CONDUCTOR_PORT:-}" =~ ^[1-9][0-9]{0,4}$ ]] || (( CONDUCTOR_PORT > 65534 )); then
  echo "CONDUCTOR_PORT must be a port between 1 and 65534 (Wallet uses the next port)." >&2
  exit 1
fi
export USER_HTTP_PORT="$CONDUCTOR_PORT"
export WALLET_HTTP_PORT="$((CONDUCTOR_PORT + 1))"

cleanup() {
  local status=$?
  trap - EXIT
  bun run env:down --environment=development --run=conductor || {
    local cleanup_status=$?
    if (( status == 0 )); then status=$cleanup_status; fi
  }
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bun run env:prepare --environment=development --run=conductor
for app in user wallet; do
  DATABASE_APP="$app" bun run env:exec --environment=development --run=conductor -- bun run migration:up
done
bun run env:exec --environment=development --run=conductor -- bun run start:dev
