-- B4-5 (BPR-044, BG-09): the locally held recovery kit. The server keeps one
-- row per account holding only an argon2id verifier of the kit secret, never
-- the secret. Enrolment replaces the row (one active kit per account), a
-- successful recovery sets used_at so the kit is spent, and the account row
-- cascades on a hard delete, and DeleteAccount purges it explicitly.
CREATE TABLE IF NOT EXISTS recovery_kits (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier   TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    used_at    TEXT
);
