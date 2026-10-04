#!/usr/bin/env bash
set -euo pipefail

expected_bun=$(cat .bun-version)
if [[ "$(bun --version)" != "$expected_bun" ]]; then
  echo "Install Bun $expected_bun before running Conductor setup." >&2
  exit 1
fi
rg --version
make --version
bun install --frozen-lockfile
bun --bun ./node_modules/.bin/nx --version
bun --bun ./node_modules/.bin/prettier --version
