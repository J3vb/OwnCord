-- Persist rate-limit lockouts so they survive server restarts.
CREATE TABLE IF NOT EXISTS rate_lockouts (
    key        TEXT    PRIMARY KEY,
    expires_at TEXT    NOT NULL
);
