#!/usr/bin/env bash
# Wrapper stdio para MCP: resuelve rutas relativas al repo (deeplinks / clientes MCP).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/dist/index.js"
