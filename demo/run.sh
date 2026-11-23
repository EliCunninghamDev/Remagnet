#!/usr/bin/env bash
# Rebuild the Chrome extension, prepare the demo addon, and record the clip.
#
# Requires web-demo-mcp (https://github.com/…/web-demo-mcp) with its system
# dependencies installed. Override its path with WEB_DEMO_MCP=/path/to/bin.
set -euo pipefail
cd "$(dirname "$0")/.."

WEB_DEMO_MCP="${WEB_DEMO_MCP:-web-demo-mcp}"

bun run build
bun demo/prepare-addon.mjs

bun demo/mock-proxy.ts &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null || true' EXIT
sleep 0.6

"$WEB_DEMO_MCP" run demo/remagnet.yaml --seed 7 "$@"
