-- reports is the B5-8 report intake, queue and evidence snapshot (migration
-- 048). Keep this file ASCII-only: sqlc v1.30 truncates the next query by
-- the byte/rune difference of any multi-byte character.

-- name: InsertReport :one
-- public_id is generated in Go (crypto/rand) before this runs; the UNIQUE
-- constraint on it is not expected to ever fire. idx_reports_active_unique
-- (migration 048) is the constraint expected to fire here on a race: two
-- simultaneous filings of the same (reporter, target) both reach this
-- INSERT, and the loser's violates that partial unique index.
-- Re-validated inside the transaction (Codex review, P1-4 widened): the
-- evidence snapshot is built and the reporter/subject resolved before the
-- transaction opens, so an erasure landing between that resolution and this
-- INSERT must not restore a since-erased reporter or subject id -- the
-- INSERT ... SELECT ... WHERE EXISTS guard turns that race into zero rows
-- (mapped to db.ErrNotFound) rather than a row naming an erased account.
-- subject_id = 0 is a valid, principal-less target (an attachment with no
-- resolvable uploader) and skips the EXISTS check for it.
INSERT INTO reports (public_id, reporter_id, subject_id, target_type, target_ref, channel_id, reason, detail)
SELECT sqlc.arg(public_id), sqlc.arg(reporter_id), sqlc.arg(subject_id), sqlc.arg(target_type),
       sqlc.arg(target_ref), sqlc.arg(channel_id), sqlc.arg(reason), sqlc.arg(detail)
 WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(reporter_id))
   AND (sqlc.arg(subject_id) = 0 OR EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(subject_id)))
RETURNING id;

-- name: GetReportByID :one
SELECT id, public_id, reporter_id, reporter_token, subject_id, subject_token, target_type,
       target_ref, channel_id, reason, detail, state, assignee_id, outcome,
       created_at, updated_at, closed_at
  FROM reports WHERE id = ?;

-- name: GetReportByPublicID :one
-- The only lookup a route parameter or a mod_queue frame's id ever drives:
-- public_id is the sole externally-visible identifier (Codex review).
SELECT id, public_id, reporter_id, reporter_token, subject_id, subject_token, target_type,
       target_ref, channel_id, reason, detail, state, assignee_id, outcome,
       created_at, updated_at, closed_at
  FROM reports WHERE public_id = ?;

-- name: FindOpenOrAssignedReport :one
-- The dedupe FAST PATH: the same reporter, the same target, an open or
-- assigned report already exists. This is a pre-check only -- it saves the
-- caller building an evidence snapshot for a report that will be refused --
-- idx_reports_active_unique (migration 048) is what actually enforces the
-- rule under concurrency; this query has no such guarantee alone.
SELECT id FROM reports
 WHERE reporter_id = ? AND target_type = ? AND target_ref = ?
   AND state IN ('open', 'assigned')
 LIMIT 1;

-- name: ListReportsByState :many
-- Either concrete queue state, taken alone ("open" or "assigned").
SELECT r.id, r.public_id, r.reporter_id, r.subject_id, r.target_type, r.target_ref,
       r.channel_id, r.reason, r.state, r.assignee_id, r.outcome,
       r.created_at, r.updated_at, r.closed_at,
       COALESCE(ru.username, '') AS reporter_name,
       COALESCE(su.username, '') AS subject_name
  FROM reports r
  LEFT JOIN users ru ON ru.id = r.reporter_id
  LEFT JOIN users su ON su.id = r.subject_id
 WHERE r.state = ?
 ORDER BY r.created_at DESC, r.id DESC;

-- name: ListReportsOpenOrAssigned :many
-- The default queue view: open and assigned together.
SELECT r.id, r.public_id, r.reporter_id, r.subject_id, r.target_type, r.target_ref,
       r.channel_id, r.reason, r.state, r.assignee_id, r.outcome,
       r.created_at, r.updated_at, r.closed_at,
       COALESCE(ru.username, '') AS reporter_name,
       COALESCE(su.username, '') AS subject_name
  FROM reports r
  LEFT JOIN users ru ON ru.id = r.reporter_id
  LEFT JOIN users su ON su.id = r.subject_id
 WHERE r.state IN ('open', 'assigned')
 ORDER BY r.created_at DESC, r.id DESC;

-- name: ListReportsClosed :many
-- state=closed groups every terminal state, including the erasure-forced one.
SELECT r.id, r.public_id, r.reporter_id, r.subject_id, r.target_type, r.target_ref,
       r.channel_id, r.reason, r.state, r.assignee_id, r.outcome,
       r.created_at, r.updated_at, r.closed_at,
       COALESCE(ru.username, '') AS reporter_name,
       COALESCE(su.username, '') AS subject_name
  FROM reports r
  LEFT JOIN users ru ON ru.id = r.reporter_id
  LEFT JOIN users su ON su.id = r.subject_id
 WHERE r.state IN ('resolved', 'dismissed', 'subject_erased')
 ORDER BY r.created_at DESC, r.id DESC;

-- name: ListReportsMine :many
-- The reporter's own view: never the assignee, never the notes.
SELECT id, public_id, target_type, reason, state, outcome, created_at, closed_at
  FROM reports
 WHERE reporter_id = ?
 ORDER BY created_at DESC, id DESC;

-- name: AssignReport :execrows
-- Guarded three ways: state (nothing leaves a closed state), the OBSERVED
-- assignee (optimistic concurrency -- a concurrent reassignment moves this
-- out from under a racing caller, so its stale outrank verdict can never be
-- applied), and EXISTS(users) (a moderator erased between requirePerm and
-- this write cannot land as the new assignee). Zero rows affected covers
-- all three causes; the caller answers 409 for each.
UPDATE reports
   SET assignee_id = sqlc.arg(assignee_id), state = 'assigned', updated_at = datetime('now')
 WHERE reports.id = sqlc.arg(id)
   AND reports.state IN ('open', 'assigned')
   AND reports.assignee_id = sqlc.arg(observed_assignee_id)
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(assignee_id));

-- name: CloseReport :execrows
-- open -> resolved|dismissed is close-without-assigning; assigned ->
-- resolved|dismissed is the ordinary path. Nothing leaves a closed state.
UPDATE reports
   SET state = ?, outcome = ?, closed_at = datetime('now'), updated_at = datetime('now')
 WHERE id = ? AND state IN ('open', 'assigned');

-- name: InsertReportEvidence :exec
-- Guarded (Codex review, P1-4 widened): an evidence row's author erased
-- between the snapshot's capture and this transaction's commit must not
-- land -- the row is silently dropped (0 = a valid author-less context row,
-- e.g. a system message, and skips the check).
INSERT INTO report_evidence (report_id, seq, message_id, author_id, content, attachments)
SELECT sqlc.arg(report_id), sqlc.arg(seq), sqlc.arg(message_id), sqlc.arg(author_id), sqlc.arg(content), sqlc.arg(attachments)
 WHERE sqlc.arg(author_id) = 0 OR EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(author_id));

-- name: ListReportEvidence :many
SELECT report_id, seq, message_id, author_id, author_token, content, attachments, captured_at
  FROM report_evidence
 WHERE report_id = ?
 ORDER BY seq;

-- name: InsertReportNote :execrows
-- INSERT ... SELECT ... WHERE EXISTS, not a bare INSERT: a moderator erased
-- between requirePerm and this write must not land as a note's author, and
-- (Codex review) the report must still be open/assigned -- a note added
-- between GetReport's read and this write, on a report a concurrent Close
-- just closed, must not land either. Both guards are in the one INSERT's
-- WHERE clause, so there is no read-then-write gap between them. Zero rows
-- affected means the caller answers 409, for either cause.
INSERT INTO report_notes (report_id, author_id, body)
SELECT sqlc.arg(report_id), sqlc.arg(author_id), sqlc.arg(body)
 WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(author_id))
   AND EXISTS (SELECT 1 FROM reports r WHERE r.id = sqlc.arg(report_id) AND r.state IN ('open', 'assigned'));

-- name: ListReportNotes :many
SELECT id, report_id, author_id, author_token, body, created_at
  FROM report_notes
 WHERE report_id = ?
 ORDER BY id;

-- name: PruneReportEvidenceOlderThan :execrows
DELETE FROM report_evidence
 WHERE report_id IN (SELECT id FROM reports WHERE closed_at IS NOT NULL AND closed_at < ?);

-- name: PruneReportNotesOlderThan :execrows
DELETE FROM report_notes
 WHERE report_id IN (SELECT id FROM reports WHERE closed_at IS NOT NULL AND closed_at < ?);

-- name: PruneReportDetailOlderThan :execrows
UPDATE reports SET detail = ''
 WHERE closed_at IS NOT NULL AND closed_at < ? AND detail != '';

-- name: InsertReportEvent :exec
-- report_events is this feature's own immutable history, never the shared
-- audit_log (second Codex review): detail is the state or outcome word
-- only, never free text.
INSERT INTO report_events (report_id, actor_id, action, detail)
VALUES (?, ?, ?, ?);

-- name: ListReportEvents :many
SELECT id, report_id, actor_id, actor_token, action, detail, created_at
  FROM report_events
 WHERE report_id = ?
 ORDER BY id;
