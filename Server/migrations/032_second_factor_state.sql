-- B4-3 (S-13, BPR-046): durable second-factor state. Three stores that were
-- process-local until now (a restart forgot used codes, dropped in-flight
-- login challenges and pending enrolments) persist here, secrets never in the
-- clear: the partial-auth token and the used code are SHA-256 digests, and
-- the pending enrolment secret is AES-GCM ciphertext under the TOTP key,
-- exactly like users.totp_secret. Emergency recovery codes are bcrypt hashes,
-- one row per code, consumed by setting used_at.
--
-- Every table cascades from users(id) for a hard delete and is purged
-- explicitly by db.DeleteAccount (the anonymise path keeps the users row).
-- Timestamps are RFC3339 UTC text, compared as text like sessions.expires_at.

CREATE TABLE IF NOT EXISTS partial_auth_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device     TEXT    NOT NULL DEFAULT '',
    ip_address TEXT    NOT NULL DEFAULT '',
    failures   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_partial_auth_challenges_expires ON partial_auth_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_partial_auth_challenges_user ON partial_auth_challenges(user_id);

CREATE TABLE IF NOT EXISTS pending_totp_enrollments (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_totp_enrollments_expires ON pending_totp_enrollments(expires_at);

CREATE TABLE IF NOT EXISTS totp_used_codes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT    NOT NULL,
    expires_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_totp_used_codes_expires ON totp_used_codes(expires_at);

CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_totp_recovery_codes_user ON totp_recovery_codes(user_id);
