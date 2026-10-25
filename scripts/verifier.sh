#!/usr/bin/env bash
# Start one verifier operator. Usage: scripts/verifier.sh 1|2|3
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --env-file=.env packages/verifier/index.mjs --operator "${1:-1}"
