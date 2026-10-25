#!/usr/bin/env bash
# Expose the local coordinator (127.0.0.1:4500) on a public HTTPS URL so a Quicknode Stream (or a
# deployed AgentCore runtime) can reach POST /webhooks/quicknode and the coordinator API.
# Uses whichever of cloudflared (quick tunnel, no account needed) or ngrok is installed.
# Usage: scripts/tunnel.sh [port]        (default 4500)
# The public URL is printed and written to .state/tunnel-<port>.url; stop with Ctrl-C.
# Run it once per service that must be public: 4500 (coordinator) and each node port (4401...).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-4500}"
mkdir -p .state
URL_FILE=".state/tunnel-${PORT}.url"
: > "$URL_FILE"

if command -v cloudflared >/dev/null 2>&1; then
  echo "[tunnel] cloudflared quick tunnel -> http://127.0.0.1:${PORT} (no account; URL changes on every start)"
  # cloudflared prints the assigned *.trycloudflare.com URL on stderr once the tunnel is up.
  cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate 2>&1 | while IFS= read -r line; do
    if [[ -z "$(cat "$URL_FILE")" && "$line" =~ (https://[a-zA-Z0-9.-]+\.trycloudflare\.com) ]]; then
      url="${BASH_REMATCH[1]}"
      echo "$url" > "$URL_FILE"
      echo
      echo "[tunnel] public URL:        $url"
      echo "[tunnel] Stream destination: ${url}/webhooks/quicknode"
      echo "[tunnel] coordinator API:    ${url}   (saved to ${URL_FILE})"
      echo
    fi
    echo "$line"
  done
elif command -v ngrok >/dev/null 2>&1; then
  echo "[tunnel] ngrok -> http://127.0.0.1:${PORT} (needs 'ngrok config add-authtoken' once)"
  ngrok http "$PORT" --log=stdout --log-format=logfmt 2>&1 | while IFS= read -r line; do
    if [[ -z "$(cat "$URL_FILE")" && "$line" =~ url=(https://[a-zA-Z0-9.-]+) ]]; then
      url="${BASH_REMATCH[1]}"
      echo "$url" > "$URL_FILE"
      echo
      echo "[tunnel] public URL:        $url"
      echo "[tunnel] Stream destination: ${url}/webhooks/quicknode"
      echo "[tunnel] coordinator API:    ${url}   (saved to ${URL_FILE})"
      echo
    fi
    echo "$line"
  done
else
  echo "[tunnel] neither cloudflared nor ngrok is installed." >&2
  echo "         brew install cloudflared      # quick tunnels need no account" >&2
  echo "         (or: brew install ngrok && ngrok config add-authtoken <token>)" >&2
  exit 1
fi
