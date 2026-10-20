#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# get-token.sh — Obtain a Cognito JWT for the AgentCore Gateway and export it as
# AGENTCORE_JWT (and AUTH_TOKEN, for the test scripts).
#
# This is the inbound auth (client -> Gateway) credential. The Gateway validates
# the JWT against the loom (Calanthir) Cognito pool's OIDC discovery URL — loom is
# the one enterprise IdP; the gateway creates no pool of its own.
#
# Reads the pool/client from SSM Parameter Store (published by the CDK stack, now
# pointing at loom). The password comes from the COGNITO_PASSWORD env var — loom
# users and their passwords are managed IN loom (console / your own seeding), NOT
# by this stack, so there is no Secrets Manager demo secret to read.
# Authenticates with ADMIN_USER_PASSWORD_AUTH (IAM-gated admin flow against the
# loom user client; no third-party SRP dependency).
#
# Prereq: the loom user exists with a permanent password and is in the
# `clinical-staff` group (for the EHR tool's Cedar gate).
#
# Usage (credentials come from your environment — none are baked into this script):
#   COGNITO_USERNAME=<user> COGNITO_PASSWORD=<pw> source scripts/get-token.sh
#   COGNITO_USERNAME=<user> COGNITO_PASSWORD=<pw> ./scripts/get-token.sh   # prints token
#
# Env overrides (take precedence over SSM):
#   AWS_REGION, SSM_PREFIX, COGNITO_USER_POOL_ID, COGNITO_APP_CLIENT_ID,
#   COGNITO_USERNAME, COGNITO_PASSWORD, TOKEN_TYPE (access|id)
#
# NOTE: this script is meant to be `source`d, so it deliberately does NOT enable
# `set -euo pipefail` globally — that would leak errexit/nounset into the caller's
# interactive shell (and breaks under zsh, the macOS default). Errors are handled
# explicitly via _die below.

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
SSM_PREFIX="${SSM_PREFIX:-/enterprise-mcp-gateway}"
TOKEN_TYPE="${TOKEN_TYPE:-access}"   # 'access' or 'id'

err() { echo "ERROR: $*" >&2; }

# Detect sourced-vs-executed in BOTH bash and zsh. Avoids the bash-only
# ${BASH_SOURCE[0]} (which errors under set -u in zsh).
_sourced=0
if [ -n "${ZSH_VERSION:-}" ]; then
  case "${ZSH_EVAL_CONTEXT:-}" in *:file*) _sourced=1 ;; esac
elif [ -n "${BASH_VERSION:-}" ]; then
  (return 0 2>/dev/null) && _sourced=1
fi
_die() { err "$*"; if [ "${_sourced}" -eq 1 ]; then return 1; else exit 1; fi; }

command -v aws >/dev/null 2>&1 || { _die "aws CLI not found on PATH."; return 1 2>/dev/null || exit 1; }
command -v python3 >/dev/null 2>&1 || { _die "python3 not found on PATH."; return 1 2>/dev/null || exit 1; }

ssm_get() {
  aws ssm get-parameter --region "$REGION" --name "$1" \
    --query 'Parameter.Value' --output text 2>/dev/null || true
}

# --- Resolve connection details (env overrides win, else SSM -> loom) ---
POOL_ID="${COGNITO_USER_POOL_ID:-$(ssm_get "${SSM_PREFIX}/cognito/pool-id")}"
CLIENT_ID="${COGNITO_APP_CLIENT_ID:-$(ssm_get "${SSM_PREFIX}/cognito/client-id")}"
# NB: zsh reserves $USERNAME (it tracks the OS login user), so when this script is
# sourced into zsh a local var named USERNAME won't take. Use COGNITO_USER instead.
# No default identity is baked in — the caller supplies COGNITO_USERNAME.
COGNITO_USER="${COGNITO_USERNAME:-}"

# Password comes from the COGNITO_PASSWORD env var. Loom users and their passwords
# are managed in loom (the enterprise IdP), NOT by this stack — there is no
# Secrets Manager demo secret to read.
PASSWORD="${COGNITO_PASSWORD:-}"

MISSING=""
[ -z "${POOL_ID:-}" ] || [ "${POOL_ID}" = "None" ] && MISSING="${MISSING} user-pool-id"
[ -z "${CLIENT_ID:-}" ] || [ "${CLIENT_ID}" = "None" ] && MISSING="${MISSING} app-client-id"
[ -z "${COGNITO_USER:-}" ] && MISSING="${MISSING} username(set COGNITO_USERNAME)"
[ -z "${PASSWORD:-}" ] && MISSING="${MISSING} password(set COGNITO_PASSWORD)"
if [ -n "$MISSING" ]; then
  err "Missing required value(s):${MISSING}."
  err "Deploy the CDK stack (publishes ${SSM_PREFIX}/cognito/* pointing at loom), and"
  err "pass the loom user's credentials via COGNITO_USERNAME and COGNITO_PASSWORD env vars."
  _die "Cannot mint a token."
  return 1 2>/dev/null || exit 1
fi

echo "Authenticating '${COGNITO_USER}' via ADMIN_USER_PASSWORD_AUTH (client ${CLIENT_ID}, region ${REGION})..." >&2

# Build auth-parameters as JSON (not the comma/equals-delimited shorthand): a
# generated password may contain ',' or '=', which would corrupt the shorthand.
# Pass the password via env so the shell never has to quote it.
AUTH_PARAMS="$(COGNITO_USER="$COGNITO_USER" COGNITO_PW="$PASSWORD" python3 -c \
  'import os, json; print(json.dumps({"USERNAME": os.environ["COGNITO_USER"], "PASSWORD": os.environ["COGNITO_PW"]}))')"

AUTH_JSON="$(aws cognito-idp admin-initiate-auth \
  --region "$REGION" \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "$AUTH_PARAMS" \
  --output json 2>/tmp/get-token.err)" || {
    err "admin-initiate-auth failed:"; cat /tmp/get-token.err >&2 || true
    _die "Could not authenticate. Check COGNITO_USERNAME/COGNITO_PASSWORD against the loom pool."
    return 1 2>/dev/null || exit 1
  }

# A permanent password means no challenge is expected.
CHALLENGE="$(printf '%s' "$AUTH_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ChallengeName",""))' 2>/dev/null || true)"
if [ -n "$CHALLENGE" ]; then
  _die "Unexpected auth challenge '${CHALLENGE}'. Set a permanent password on the loom user (admin-set-user-password --permanent)."
  return 1 2>/dev/null || exit 1
fi

TOKEN="$(printf '%s' "$AUTH_JSON" | python3 -c '
import sys, json
ttype = sys.argv[1] if len(sys.argv) > 1 else "access"
res = json.load(sys.stdin).get("AuthenticationResult", {})
key = "IdToken" if ttype == "id" else "AccessToken"
print(res.get(key) or res.get("AccessToken") or res.get("IdToken") or "")
' "$TOKEN_TYPE")"

if [ -z "$TOKEN" ]; then
  err "Authentication succeeded but no token was returned. Raw response:"
  printf '%s\n' "$AUTH_JSON" >&2
  _die "No token."
  return 1 2>/dev/null || exit 1
fi

export AGENTCORE_JWT="$TOKEN"
export AUTH_TOKEN="$TOKEN"
echo "Exported AGENTCORE_JWT and AUTH_TOKEN (${TOKEN_TYPE} token, ${#TOKEN} chars)." >&2

# When executed (not sourced), print the token so callers can capture it.
if [ "${_sourced}" -eq 0 ]; then
  printf '%s\n' "$TOKEN"
fi
