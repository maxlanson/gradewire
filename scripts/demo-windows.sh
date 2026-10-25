#!/usr/bin/env bash
# Open one small Terminal window per node, side by side along the bottom of the screen, each
# running the node panel (letter, CPU, dollars). Usage:
#   scripts/demo-windows.sh "A http://127.0.0.1:4421 honest" "B http://127.0.0.1:4422 unreliable" "C http://127.0.0.1:4423 cheater"
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
W=${PANEL_W:-470}; H=${PANEL_H:-300}; X0=${PANEL_X:-20}; Y0=${PANEL_Y:-660}
i=0
for spec in "$@"; do
  read -r letter url role <<<"$spec"
  cmd="cd '$ROOT' && clear && node packages/node/panel.mjs $letter $url --role ${role:-honest}"
  x=$((X0 + i * (W + 12)))
  osascript - "$cmd" "$x" "$Y0" "$((x + W))" "$((Y0 + H))" <<'APPLESCRIPT'
on run argv
  set theCmd to item 1 of argv
  tell application "Terminal"
    activate
    set w to do script theCmd
    delay 0.4
    set bounds of front window to {(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}
  end tell
end run
APPLESCRIPT
  i=$((i + 1))
done
echo "opened $i panel window(s)"
