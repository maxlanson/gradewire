#!/usr/bin/env bash
# Ask a question; the model splits it into Python programs that paid, verified nodes run.
# Usage: scripts/ask.sh "How many primes are there below 10 million?" [--parts 3] [--max-price 0.01]
#        [--min-score 0.8] [--no-settle] [--dry-run] [--node http://127.0.0.1:4401]
set -euo pipefail
cd "$(dirname "$0")/.."
export TEAM_NAME="${TEAM_NAME:-FranksDAO}"
exec node --env-file=.env packages/ask/index.mjs "$@"
