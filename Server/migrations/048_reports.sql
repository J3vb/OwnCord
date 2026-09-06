-- B5-8: local report intake and queue (BPR-070, BPR-071's server half,
-- BG-14's server half a, plan decision 7, strengthened on review). Copied
-- from the HP-5 draft (docs/plans/hp-5-drafts/reports.up.sql) plus statements
-- the draft did not carry, and deviations a Codex review of the shipped
-- draft required (recorded here so the drafts README can carry them
-- forward): granting the new MODERATE_MEMBERS bit (22, 0x400000 = 4194304)
-- to the default Moderator role, a `public_id` so the queue never leaks the
-- sequential id (see (10) below), and the partial unique index at (11) that
-- makes the dedupe check race-proof instead of merely a pre-check.
--
-- The grant is scoped to the UNTOUCHED default Moderator row only:
-- id = 3 AND name = 'Moderator' AND permissions = 3145727 (0x2FFFFF). That
-- is NOT 001_initial_schema.sql's seed value (0x000FFFFF / 1048575) --
-- migration 022_message_mentions.sql unconditionally ORs bit 21
-- (MENTION_EVERYONE, 0x200000) into roles 1/2/3, so 0x2FFFFF is what an
-- untouched Moderator role actually holds by the time this migration runs.
-- Tracing the value THROUGH every migration up to this one, not just
-- reading the 001 seed, is what this condition depends on -- a further
-- migration that touches role 3 owes this comment and condition an update.
-- A prior draft of this migration granted on
-- `id = 3 OR name = 'Moderator'`, which would hand confidential-report
-- access to whatever role an operator had repurposed id 3 for, or renamed
-- into 'Moderator'. Grant-by-exact-match means an install whose Moderator
-- role was ever customised (renamed, or its permissions edited) does NOT
-- get MODERATE_MEMBERS automatically -- the operator grants "Moderate
-- Members" by hand in the admin panel's role grid
-- (docs/server-configuration.md documents this).
--
-- (1) A report names two principals -- the reporter and the subject -- so
-- it carries two token columns, the same shape audit_log grew across
-- migrations 038 and 041 for the same reason (one erased principal must not
-- overwrite the other's unlinking token).
--
-- (2) reporter_id / subject_id / assignee_id / author_id are bare
-- integers with DEFAULT 0 and deliberately NO foreign key. A foreign-key
-- cascade on subject_id would delete the outcome row with the subject,
-- which is exactly what decision 7 forbids -- the outcome must outlive the
-- account. Erasure instead sets the id to 0 and fills the matching token
-- column, the audit_log pattern.
--
-- (3) channel_id is a bare integer for the same reason: a deleted channel
-- must not delete its reports. There is no channel_token, because a
-- channel is not a subject with an erasure right -- a dangling id is
-- sufficient (compare report_id in moderation_actions, which is bare for
-- the mirror-image reason: a pruned report must not orphan the action it
-- gave rise to).
--
-- (4) Decision 7 in SQL terms, run on the SUBJECT's erasure (HP-5 review
-- widened this: the surviving row must carry no content of any kind,
-- including notes ABOUT the subject that the subject never even saw):
--   DELETE FROM report_evidence
--    WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)
--       OR author_id = ?
--   -- content gone, including the subject's own messages appearing as
--   -- context in someone else's report
--   DELETE FROM report_notes
--    WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)
--   UPDATE reports
--      SET subject_id = 0,
--          subject_token = ?,
--          detail = '',
--          target_ref = '',
--          state = CASE WHEN closed_at IS NULL THEN 'subject_erased' ELSE state END,
--          outcome = CASE WHEN closed_at IS NULL THEN 'subject_erased' ELSE outcome END,
--          closed_at = COALESCE(closed_at, datetime('now'))
--    WHERE subject_id = ?
-- The row that survives carries action, time, order and the marker token,
-- and nothing else. On the REPORTER's erasure, reporter_id / reporter_token
-- change AND detail is cleared -- the free text is the reporter's own
-- content just as much as the evidence snapshot is the subject's -- but the
-- report and its outcome (state/outcome/closed_at) are not touched. Notes
-- and assignments made by an erased moderator go to 0 plus that moderator's
-- own token (assignee_id has no token column, so it goes to 0 alone).
--
-- (5) report_evidence.seq: 0 is the reported item itself, -N..-1 are the
-- messages immediately before it, 1..N are the messages immediately after,
-- with N fixed in code (the HP-5 scorecard rules N = 5). A context message
-- that the retention sweep, or the author, has already removed by report
-- time is simply absent from the snapshot -- there is no placeholder row
-- for it.
--
-- (6) report_evidence.attachments is a JSON list of
-- {id, filename, mime, size} -- REFERENCES, never bytes and never the
-- storage-layer stored_as name. A snapshot therefore neither pins a file
-- against the orphan sweep or the retention sweep, nor dangles a live
-- pointer into storage internals. This is the S5 storage-exhaustion
-- question, answered deliberately: it dangles by reference, and the queue
-- shows "file no longer available" when the referenced id is gone.
--
-- (7) DM reports: the snapshot carries the reported message and its
-- surrounding context ONLY when the reporter is a participant in that DM.
-- A DM report is therefore the one path into DM content that no permission
-- otherwise grants -- worth saying plainly, because every other product
-- surface (search, admin, moderation) refuses a non-participant outright.
--
-- (8) Retention: N days after closed_at, evidence, notes and detail are
-- deleted and the reports row itself is kept (moderation.report_retention_days,
-- default 180, 0 = never). Content is bounded, the outcome is indefinite --
-- this is the S5-d answer. Open reports (closed_at IS NULL) are never
-- pruned by this window.
--
-- (9) The outcome row lives in the SQLite file, so it is durable against an
-- account erasure and NOT durable against a restore of an older backup --
-- stated here, not defended: a restore taken before a report closed simply
-- does not have the row.
--
-- (10) public_id (Codex review, not in the HP-5 draft): the sequential
-- integer id is never exposed outside the server -- every API response,
-- every route parameter and the mod_queue frame carry public_id instead.
-- Sequential ids leak order: a bit holder who files reports 1 and 3 and
-- never sees 2 in any queue view they can read infers report 2 is about
-- them. public_id is 16 random bytes from crypto/rand, hex-encoded (32
-- chars), generated in Go at file time -- opaque and unguessable, so seeing
-- one report's id reveals nothing about neighbouring reports.
--
-- (11) idx_reports_active_unique (Codex review, not in the HP-5 draft): the
-- HP-5 draft's dedupe check was a SELECT before the INSERT -- correct
-- sequentially, racy concurrently (two simultaneous filings of the same
-- target both pass the SELECT before either INSERT lands). The partial
-- unique index below makes SQLite itself the second, race-proof gate: the
-- loser's INSERT fails UNIQUE constraint, which the Go layer maps to
-- DUPLICATE_REPORT. `reporter_id <> 0` excludes an erased reporter's rows
-- from the constraint, since decision 7 leaves many closed/erased reports
-- sharing reporter_id = 0 and they must not collide with each other.
CREATE TABLE IF NOT EXISTS reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id      TEXT    NOT NULL UNIQUE,
    reporter_id    INTEGER NOT NULL DEFAULT 0,
    reporter_token TEXT,
    subject_id     INTEGER NOT NULL DEFAULT 0,
    subject_token  TEXT,
    target_type    TEXT    NOT NULL CHECK (target_type IN ('message', 'user', 'attachment')),
    target_ref     TEXT    NOT NULL,
    channel_id     INTEGER,
    reason         TEXT    NOT NULL,
    detail         TEXT    NOT NULL DEFAULT '',
    state          TEXT    NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open', 'assigned', 'resolved', 'dismissed', 'subject_erased')),
    assignee_id    INTEGER NOT NULL DEFAULT 0,
    outcome        TEXT    NOT NULL DEFAULT ''
                   CHECK (outcome IN ('', 'actioned', 'no_action', 'duplicate', 'subject_erased')),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_queue    ON reports(state, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_subject  ON reports(subject_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_dedupe   ON reports(reporter_id, target_type, target_ref);
-- See (11) above: the race-proof half of the dedupe check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_active_unique
    ON reports(reporter_id, target_type, target_ref)
 WHERE state IN ('open', 'assigned') AND reporter_id <> 0;

CREATE TABLE IF NOT EXISTS report_evidence (
    report_id    INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    message_id   INTEGER,
    author_id    INTEGER NOT NULL DEFAULT 0,
    author_token TEXT,
    content      TEXT    NOT NULL,
    attachments  TEXT    NOT NULL DEFAULT '[]',
    captured_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (report_id, seq)
);

CREATE TABLE IF NOT EXISTS report_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id    INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    author_id    INTEGER NOT NULL DEFAULT 0,
    author_token TEXT,
    body         TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The one statement the HP-5 draft did not carry (plan B5-8, item 1): grant
-- the queue's permission bit to the default Moderator role so the queue has
-- a reader out of the box. 4194304 = 0x400000 = bit 22. Scoped to the
-- untouched default row only -- see the header comment for why 3145727,
-- not the 001 seed value, is the right comparison.
UPDATE roles SET permissions = permissions | 4194304
 WHERE id = 3 AND name = 'Moderator' AND permissions = 3145727;
