#!/bin/bash
# SessionStart hook for Claude Code on the web: install what tests/linters need
# so CI-mirroring checks work from the first turn of a remote session.
set -euo pipefail

# Only needed in remote (web) sessions — local machines manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Client: npm deps power tsc, eslint, oxlint, prettier, vitest.
# npm install (not ci) so the cached container state is reused across sessions.
(cd Client/tauri-client && npm install --no-audit --no-fund)

# Server: warm the Go module cache (go.mod may also auto-download Go 1.25
# via GOTOOLCHAIN on first build).
(cd Server && go mod download)

# Use the repo's committed git hooks so commits made in the session get the
# same fast checks CI enforces.
git config core.hooksPath .githooks

echo "OwnCord session setup complete."
