#!/usr/bin/env bash
# Run the trainer agent. Usage: scripts/trainer.sh [--node http://127.0.0.1:4401] [--jobs 4]
set -euo pipefail
cd "$(dirname "$0")/.."
export TEAM_NAME="${TEAM_NAME:-FranksDAO}"
exec node --env-file=.env packages/trainer/index.mjs "$@"
