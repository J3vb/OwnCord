-- B5-10: rate-limited appeals against a moderation action (BPR-073, plan
-- decision 8). Based on the HP-5 draft
-- (docs/plans/hp-5-drafts/appeals.up.sql) -- see that file's header for the
-- full rationale (the UNIQUE(action_id) memory, the rate limit living in
-- auth.RateLimiter rather than this schema, the sole-moderator escape
-- hatch, decision_note's audit-detail-denylist obligation, and the
-- erasure/token shape). Reproduced here only where this migration's own
-- behaviour needs restating or where it deviates from that draft.
--
-- Deviation from the draft (B5-8/B5-9 review round): a `public_id` column,
-- the same shape reports.public_id already carries (migration 048) -- 16
-- random bytes from crypto/rand, hex-encoded, generated in Go at submission
-- time. Every route parameter, API response and mod_queue frame carries
-- this instead of the sequential id, for the identical reason reports
-- adopted one: appeals are filed in sequence server-side, so a moderator
-- who can see appeals 1 and 3 but never 2 in any queue view they can read
-- would otherwise infer appeal 2 concerns someone specific. The draft's
-- UNIQUE(action_id) is unaffected -- it still enforces decision 8's "one
-- appeal per action, ever" on the internal id, which is what the foreign
-- key and every join in this file operate on -- public_id is purely the
-- externally-visible address.
--
-- appellant_id cascades on ON DELETE (S6-d: an appeal is deleted for the
-- appellant on their own erasure -- unlike a report's outcome row, which
-- decision 7 keeps, an appeal has no "keep the outcome, drop the content"
-- half: the UNIQUE(action_id) memory that forbids re-appeal survives with
-- the ROW gone, because the action itself still exists and a fresh appeal
-- against it would need a fresh appellant who no longer exists either).
--
-- decided_by/decided_by_token is the bare-id-plus-token pattern (migration
-- 048/049's rationale applies unchanged): the deciding moderator's identity
-- must not be lost from the ledger just because they later erase their own
-- account. assignee_id is a bare id with no token column, mirroring
-- reports.assignee_id and moderation_actions.lifted_by.
CREATE TABLE IF NOT EXISTS appeals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id        TEXT    NOT NULL UNIQUE,
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
