#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export NODE_ENV="${NODE_ENV:-development}"
export WME_HOST="${WME_HOST:-127.0.0.1}"
export WME_PORT="${WME_PORT:-4160}"
export WME_STATE_DIR="${WME_STATE_DIR:-$PWD/platform/.state/dev}"
export WME_PUBLIC_ORIGIN="${WME_PUBLIC_ORIGIN:-http://localhost:5173}"
export WME_INTERNAL_API_ORIGIN="${WME_INTERNAL_API_ORIGIN:-http://127.0.0.1:4160}"
export WME_EGRESS_ENABLED="${WME_EGRESS_ENABLED:-false}"
default_content_origin_template='http://{assetId}.localhost:4160'
export WME_CONTENT_ORIGIN_TEMPLATE="${WME_CONTENT_ORIGIN_TEMPLATE:-$default_content_origin_template}"

# Run npm run dev:web in a second terminal. Ctrl-C stops this API process.
exec npm run dev:api
