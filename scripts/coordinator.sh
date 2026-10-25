#!/usr/bin/env bash
# Start the coordinator (registry, sampling, verdict watcher, dashboard on http://127.0.0.1:4500).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --env-file=.env packages/coordinator/index.mjs "$@"
