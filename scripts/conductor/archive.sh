#!/usr/bin/env bash
set -euo pipefail

if [[ "${CONDUCTOR_IS_LOCAL:-0}" == "1" ]]; then
  bun run dev:down --run=conductor
fi
