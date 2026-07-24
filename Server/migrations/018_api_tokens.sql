-- Long-lived, revocable API tokens (bot/service tokens).
--
-- Unlike login sessions, an API token authenticates a headless client — the
-- MCP introspection tool, future bots, CI — as a specific user, inheriting that
-- user's role and permissions, via an "Authorization: Bearer <token>" header. It
-- lives in its own table (not sessions) so the per-user session cap, bulk logout
-- (ForceLogoutUser), and password/TOTP-change session wipes never touch it.
--
-- token_hash stores the SHA-256 hex of the raw token, exactly like sessions.token
-- — the raw token is shown once at creation and never persisted. An expires_at of
-- NULL means "never expires" (same convention as invites). revoked_at NULL means
-- the token is active.

CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,
    label        TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at   TEXT,
    revoked_at   TEXT
);

-- token_hash UNIQUE already indexes the auth-hot lookup. This index covers the
-- ON DELETE CASCADE and list-by-user paths.
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
