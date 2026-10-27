#!/usr/bin/env bash
# gw-mcp.sh - thin stdio<->gateway MCP bridge that mints a FRESH loom JWT on launch.
#
# A command-based MCP client (one that only takes Command + Args + Env, no URL/
# headers) launches THIS script as its server command. On every launch the script:
#   1. reads the loom user's password from the macOS Keychain (never a file),
#   2. mints a ~1h Cognito access token via get-token.sh,
#   3. exec's `npx mcp-remote <gateway-url> --header Authorization: Bearer <jwt>`,
#      which turns the remote HTTP gateway into a stdio MCP server for the client.
#
# So the "dumb" client stays dumb; this wrapper is the smart (auth) part. The token
# is minted per server-launch, NOT per request - if a single server process stays
# up longer than the token lifetime (~1h) without the client restarting it, calls
# will 401 until the client relaunches this command. For hours-long sessions use a
# re-mint-on-401 proxy instead.
#
# Setup (run ONCE, in your own terminal - keeps the password out of any file/chat):
#   security add-generic-password -s "loom-gateway" -a "$USER" -w '<loom-user-password>'
#
# Client (Kiro Crew "Add MCP") fields:
#   Command: <repo>/enterprise-mcp-governance-gateway/scripts/gw-mcp.sh
#   Arguments: (empty)
#   Environment variables: COGNITO_USERNAME=<your loom user>
#
set -euo pipefail

# --- config (override via env if needed) ---
GATEWAY_URL="${GATEWAY_URL:-https://enterprise-mcp-gateway-vxd0pqoady.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PROFILE="${AWS_PROFILE:-agentops-publisher}"
# Dedicated CLI/server app client on the loom pool (ADMIN_USER_PASSWORD_AUTH),
# SEPARATE from the Calanthir cockpit's browser PKCE client, so edits to one
# never clobber the other. get-token.sh honors COGNITO_APP_CLIENT_ID over SSM.
export COGNITO_APP_CLIENT_ID="${COGNITO_APP_CLIENT_ID:-hi2gjukmcudn24f8lavcdjg17}"
# Loom username to authenticate as. REQUIRED from the caller's environment - no
# default identity lives in this script. The password is never here either; it is
# read from the Keychain below.
: "${COGNITO_USERNAME:?set COGNITO_USERNAME to your loom user in the MCP client env}"
export COGNITO_USERNAME
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-loom-gateway}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-$USER}"
GET_TOKEN="$(cd "$(dirname "$0")" && pwd)/get-token.sh"

# stderr-only logging: stdout is the MCP stdio channel and MUST stay clean.
log() { echo "gw-mcp: $*" >&2; }

# --- password from Keychain (never from a file or argv) ---
COGNITO_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null || true)"
if [ -z "$COGNITO_PASSWORD" ]; then
  log "no Keychain password for service=$KEYCHAIN_SERVICE account=$KEYCHAIN_ACCOUNT."
  log "create it once:  security add-generic-password -s $KEYCHAIN_SERVICE -a \$USER -w YOUR_LOOM_PASSWORD"
  exit 1
fi
export COGNITO_PASSWORD

# --- mint a fresh JWT (get-token.sh prints the token on stdout when executed) ---
log "minting loom JWT for '$COGNITO_USERNAME' (region $AWS_REGION)..."
JWT="$(bash "$GET_TOKEN")" || { log "get-token.sh failed"; exit 1; }
[ -n "$JWT" ] || { log "get-token.sh returned empty token"; exit 1; }
unset COGNITO_PASSWORD
log "token minted (${#JWT} chars); starting mcp-remote bridge to the gateway."

# --- bridge stdio <-> remote gateway with the fresh Bearer header ---
exec npx -y mcp-remote "$GATEWAY_URL" --header "Authorization: Bearer ${JWT}"
