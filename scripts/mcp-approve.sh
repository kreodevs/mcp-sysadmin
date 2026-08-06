#!/usr/bin/env bash
# Genera un token de aprobación de un solo uso (5 min) para operaciones destructivas MCP.
set -euo pipefail

TTL_SECONDS="${MCP_APPROVE_TTL_SECONDS:-300}"
APPROVE_DIR="${HOME}/.config/mcp-sysadmin"
APPROVE_FILE="${SYSADMIN_APPROVE_FILE:-${APPROVE_DIR}/approve.json}"

mkdir -p "$(dirname "$APPROVE_FILE")"
TOKEN="$(openssl rand -hex 16)"
EXPIRES_AT="$(( $(date +%s) * 1000 + TTL_SECONDS * 1000 ))"

printf '{"token":"%s","expiresAt":%s}\n' "$TOKEN" "$EXPIRES_AT" > "$APPROVE_FILE"
chmod 600 "$APPROVE_FILE"

echo "Approve token (valid ${TTL_SECONDS}s):"
echo "$TOKEN"
echo ""
echo "Use in MCP tool call as confirmToken, or export temporarily:"
echo "  confirm=true confirmToken=$TOKEN"
