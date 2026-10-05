#!/usr/bin/env bash
set -euo pipefail

if [[ "${CONDUCTOR_IS_LOCAL:-0}" != "1" ]]; then
  echo "The development server requires a local Conductor workspace and Docker." >&2
  exit 1
fi
if [[ ! "${CONDUCTOR_PORT:-}" =~ ^[1-9][0-9]{0,4}$ ]] || (( CONDUCTOR_PORT > 65535 )); then
  echo "CONDUCTOR_PORT must be a port between 1 and 65535." >&2
  exit 1
fi
export GATEWAY_PROXY_PORT="$CONDUCTOR_PORT"

cleanup() {
  local status=$?
  trap - EXIT
  bun run dev:down --run=conductor || {
    local cleanup_status=$?
    if (( status == 0 )); then status=$cleanup_status; fi
  }
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bun run dev --run=conductor
