#!/bin/bash
# SessionStart hook — gets a fresh Claude Code on the web container to the point
# where `npm run typecheck`, `npm test` and `npm run build` all work.
#
# Kept deliberately small: install the workspace, then build @tally/shared,
# because server/ and web/ resolve it through its published `types`/`exports`
# and both typechecks fail with "Cannot find module '@tally/shared'" until
# shared/dist exists.
set -euo pipefail

# The Firebase MCP server (.mcp.json) authenticates through
# GOOGLE_APPLICATION_CREDENTIALS, which must be a file path. Environments that
# provide the service account key do so as base64 in Base64_Firebase; decode it
# outside the repo so it can never be committed.
if [ -n "${Base64_Firebase:-}" ]; then
  mkdir -p "$HOME/.config/tally"
  umask 077
  printf '%s' "$Base64_Firebase" | base64 -d > "$HOME/.config/tally/firebase-service-account.json"
  umask 022
fi

# Local checkouts are already set up by whoever owns them; only fix up remote
# containers, which start with no node_modules at all.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# `install` rather than `ci`: the container image is cached after this hook
# finishes, so a warm start reconciles the lockfile in about a second instead
# of deleting node_modules and refetching all 721 packages.
echo "Installing workspace dependencies…"
npm install --no-fund --no-audit

echo "Building @tally/shared…"
npm run build -w @tally/shared

echo "Ready: npm run typecheck | npm test | npm run build"
