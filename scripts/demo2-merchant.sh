#!/usr/bin/env bash
# Tier 0 / AP4M Demo 2 merchant: sells one JSON resource behind HTTP 402 on 127.0.0.1:4308.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
export MERCHANT_ID="${MERCHANT_ID:-0xb6aa1d849d8cce69e3acad00f3e938870f0ba3677404ba389e3d2b7b910fd80e}"
export MERCHANT_PAYOUT="$PAYOUT_ADDRESS"
export MERCHANT_SUBMITTER_KEY="$MERCHANT_PRIVATE_KEY"
export PRICE_RLUSD="${PRICE_RLUSD:-0.01}"
export STATE_DIRECTORY="${STATE_DIRECTORY:-./.state/demo2-merchant}"
exec node packages/ap4m/example-x402-merchant.mjs
