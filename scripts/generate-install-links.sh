#!/usr/bin/env bash
# Genera enlaces/botones de instalación MCP personalizados (rutas absolutas del repo).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${MCP_SERVER_NAME:-mcp-sysadmin}"
CONFIRM_TOKEN="${SYSADMIN_CONFIRM_TOKEN:-CHANGE_ME_openssl_rand_hex_32}"

if [[ ! -f "$ROOT/dist/index.js" ]]; then
  echo "Building mcp-sysadmin..." >&2
  (cd "$ROOT" && npm run build)
fi

RUNNER="$ROOT/scripts/run-mcp.sh"
INVENTORY="$ROOT/config/inventory.json"

if [[ ! -f "$INVENTORY" ]]; then
  echo "Tip: copy config/inventory.example.json → config/inventory.json" >&2
  INVENTORY="$ROOT/config/inventory.example.json"
fi

# Config fragments per client (stdio / local)
CURSOR_CONFIG=$(node -e "
const c = {
  command: process.argv[1],
  args: [],
  env: {
    SYSADMIN_INVENTORY_PATH: process.argv[2],
    SYSADMIN_PRODUCTION_MODE: 'true',
    SYSADMIN_CONFIRM_TOKEN: process.argv[3],
    SYSADMIN_REQUIRE_CONFIRM: 'true',
  },
};
process.stdout.write(JSON.stringify(c));
" "$RUNNER" "$INVENTORY" "$CONFIRM_TOKEN")

VSCODE_CONFIG=$(node -e "
const c = {
  name: process.argv[1],
  command: process.argv[2],
  args: [],
  env: {
    SYSADMIN_INVENTORY_PATH: process.argv[3],
    SYSADMIN_PRODUCTION_MODE: 'true',
    SYSADMIN_CONFIRM_TOKEN: process.argv[4],
    SYSADMIN_REQUIRE_CONFIRM: 'true',
  },
};
process.stdout.write(JSON.stringify(c));
" "$NAME" "$RUNNER" "$INVENTORY" "$CONFIRM_TOKEN")

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

CURSOR_B64=$(b64 "$CURSOR_CONFIG")
CURSOR_DEEPLINK="cursor://anysphere.cursor-deeplink/mcp/install?name=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$NAME'))")&config=$CURSOR_B64"
CURSOR_HTTPS="https://cursor.com/en/install-mcp?name=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$NAME'))")&config=$CURSOR_B64"

VSCODE_URI=$(python3 -c "import json, urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$VSCODE_CONFIG")
VSCODE_LINK="https://vscode.dev/redirect/mcp/install?name=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$NAME'))")&config=$VSCODE_URI"

cat <<EOF
# Install links for mcp-sysadmin
# Repo: $ROOT

## Cursor (1-click)

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)]($CURSOR_HTTPS)

Deeplink: $CURSOR_DEEPLINK

## VS Code (1-click)

[![Install MCP in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)]($VSCODE_LINK)

## Claude Desktop (~/.config or Application Support)

File: claude_desktop_config.json

$(node -e "
const cfg = {
  mcpServers: {
    [process.argv[1]]: JSON.parse(process.argv[2]),
  },
};
console.log(JSON.stringify(cfg, null, 2));
" "$NAME" "$CURSOR_CONFIG")

## Windsurf (~/.codeium/windsurf/mcp_config.json)

$(node -e "
const cfg = {
  mcpServers: {
    [process.argv[1]]: JSON.parse(process.argv[2]),
  },
};
console.log(JSON.stringify(cfg, null, 2));
" "$NAME" "$CURSOR_CONFIG")

## OpenCode (opencode.json / ~/.config/opencode/opencode.json)

$(node -e '
const base = JSON.parse(process.argv[1]);
const cfg = {
  "$schema": "https://opencode.ai/config.json",
  mcp: {
    [process.argv[2]]: {
      type: "local",
      command: [base.command],
      enabled: true,
      environment: base.env,
    },
  },
};
console.log(JSON.stringify(cfg, null, 2));
' "$CURSOR_CONFIG" "$NAME")

EOF
