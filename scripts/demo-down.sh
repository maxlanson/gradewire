#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
for f in .state/logs/*.pid; do [ -f "$f" ] && kill -TERM "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
sleep 1; echo "stopped"
