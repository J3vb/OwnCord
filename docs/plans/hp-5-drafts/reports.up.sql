-- B5-8 draft: local report intake and queue (BPR-070, BPR-071's server
-- half, BG-14's server half part a, plan decision 7, strengthened on
-- review).
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
-- (4) Decision 7 in SQL terms, run on the SUBJECT's erasure:
--   DELETE FROM report_evidence
--    WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)
--       OR author_id = ?
--   -- content gone, including the subject's own messages appearing as
--   -- context in someone else's report
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
-- and nothing else. On the REPORTER's erasure only reporter_id /
-- reporter_token change -- the report and its outcome are not the
-- reporter's content. Notes and assignments made by an erased moderator go
-- to 0 plus that moderator's own token.
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
-- (8) Retention: 180 days after closed_at, evidence, notes and detail are
-- deleted and the reports row itself is kept (moderation.report_retention_days,
-- default 180, 0 = never). Content is bounded, the outcome is indefinite --
-- this is the S5-d answer. Open reports (closed_at IS NULL) are never
-- pruned by this window.
--
-- (9) The outcome row lives in the SQLite file, so it is durable against an
-- account erasure and NOT durable against a restore of an older backup --
-- stated here, not defended: a restore taken before a report closed simply
-- does not have the row.
CREATE TABLE IF NOT EXISTS reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
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
