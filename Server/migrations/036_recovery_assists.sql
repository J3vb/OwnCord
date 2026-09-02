-- Owner-issued recovery credentials (B4-6, BPR-045): one outstanding
-- credential per account, replaced by the next issuance and deleted by the
-- redemption that consumes it. Only an argon2id verifier of the credential
-- is stored, with who issued it, the fixed wording of how the person was
-- verified, and when it expires.
CREATE TABLE recovery_assists (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    issued_by INTEGER NOT NULL,
    verification TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
