#!/usr/bin/env bash
set -euo pipefail

if [[ "${CONDUCTOR_IS_LOCAL:-0}" == "1" ]]; then
  bun run env:down --environment=development --run=conductor
fi
