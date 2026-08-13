#!/bin/bash
# SessionStart hook — gets a fresh Claude Code on the web container to the point
# where `npm run typecheck`, `npm test` and `npm run build` all work.
#
# Kept deliberately small: install the workspace, then build @tally/shared,
# because server/ and web/ resolve it through its published `types`/`exports`
# and both typechecks fail with "Cannot find module '@tally/shared'" until
# shared/dist exists.
set -euo pipefail

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
