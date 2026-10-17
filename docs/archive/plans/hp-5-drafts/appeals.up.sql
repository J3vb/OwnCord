-- B5-10 draft: rate-limited appeals against a moderation action (BPR-073,
-- plan decision 8).
--
-- UNIQUE (action_id) IS decision 8 written in the schema: one appeal per
-- action, ever. A decided appeal cannot be re-appealed, and this
-- constraint is the memory that enforces that rule -- there is no code path
-- that needs to check "has this already been appealed", the insert simply
-- fails. The row is therefore never swept -- sweeping it would silently
-- reopen the door decision 8 closes.
--
-- The per-user rolling-window submission cap lives in auth.RateLimiter
-- (key appeal:<user id>), not in this schema -- the windowed limiter
-- primitive already exists (Server/auth/ratelimit.go) and this table adds
-- no counter of its own.
--
-- "A blocked or erased appellant submits nothing" is read as: an appellant
-- who is over the rate limiter's window cap (its own lockout), or who has
-- no account left to submit from. Neither case needs schema support beyond
-- appellant_id cascading on erasure.
--
-- The moderator who took the action may not decide its own appeal WHERE
-- another moderator holding the deciding permission exists. That check
-- runs in code at decision time, against the live set of eligible
-- moderators, not against anything stored here -- the single-moderator
-- escape hatch (the acting moderator MAY decide their own appeal when they
-- are the only eligible one) is load-bearing on a one-admin install, where
-- refusing every appeal outright would be worse than the conflict of
-- interest it avoids.
--
-- decision_note is shown to the appellant, so it is held to the same
-- audit-detail denylist as reason on moderation_actions.
--
-- appellant_id cascades on ON DELETE (S6-d: an appeal is deleted for the
-- appellant on their own erasure). decided_by is the bare-id-plus-token
-- pattern: the deciding moderator's identity in the ledger must not be
-- lost just because they later erase their own account.
CREATE TABLE IF NOT EXISTS appeals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id        INTEGER NOT NULL UNIQUE REFERENCES moderation_actions(id) ON DELETE CASCADE,
    appellant_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body             TEXT    NOT NULL,
    state            TEXT    NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open', 'assigned', 'upheld', 'overturned', 'withdrawn')),
    assignee_id      INTEGER NOT NULL DEFAULT 0,
    decided_by       INTEGER NOT NULL DEFAULT 0,
    decided_by_token TEXT,
    decision_note    TEXT    NOT NULL DEFAULT '',
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    decided_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_state ON appeals(state, created_at);
