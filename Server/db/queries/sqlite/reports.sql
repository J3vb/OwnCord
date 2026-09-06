-- reports is the B5-8 report intake, queue and evidence snapshot (migration
-- 048). Keep this file ASCII-only: sqlc v1.30 truncates the next query by
-- the byte/rune difference of any multi-byte character.

-- name: InsertReport :one
INSERT INTO reports (reporter_id, subject_id, target_type, target_ref, channel_id, reason, detail)
VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING id;

-- name: GetReportByID :one
SELECT id, reporter_id, reporter_token, subject_id, subject_token, target_type,
       target_ref, channel_id, reason, detail, state, assignee_id, outcome,
       created_at, updated_at, closed_at
  FROM reports WHERE id = ?;

-- name: FindOpenOrAssignedReport :one
-- The dedupe lookup: the same reporter, the same target, an open or
-- assigned report already exists.
SELECT id FROM reports
 WHERE reporter_id = ? AND target_type = ? AND target_ref = ?
   AND state IN ('open', 'assigned')
 LIMIT 1;

-- name: ListReportsByState :many
-- Either concrete queue state, taken alone ("open" or "assigned").
SELECT r.id, r.reporter_id, r.subject_id, r.target_type, r.target_ref,
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
SELECT r.id, r.reporter_id, r.subject_id, r.target_type, r.target_ref,
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
SELECT r.id, r.reporter_id, r.subject_id, r.target_type, r.target_ref,
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
SELECT id, target_type, reason, state, outcome, created_at, closed_at
  FROM reports
 WHERE reporter_id = ?
 ORDER BY created_at DESC, id DESC;

-- name: AssignReport :execrows
-- Guarded by state: zero rows affected means the caller must answer 409.
-- force=1 (checked by the caller before this runs) is the only way to
-- reassign an already-assigned report to someone else.
UPDATE reports
   SET assignee_id = ?, state = 'assigned', updated_at = datetime('now')
 WHERE id = ? AND state IN ('open', 'assigned');

-- name: CloseReport :execrows
-- open -> resolved|dismissed is close-without-assigning; assigned ->
-- resolved|dismissed is the ordinary path. Nothing leaves a closed state.
UPDATE reports
   SET state = ?, outcome = ?, closed_at = datetime('now'), updated_at = datetime('now')
 WHERE id = ? AND state IN ('open', 'assigned');

-- name: InsertReportEvidence :exec
INSERT INTO report_evidence (report_id, seq, message_id, author_id, content, attachments)
VALUES (?, ?, ?, ?, ?, ?);

-- name: ListReportEvidence :many
SELECT report_id, seq, message_id, author_id, author_token, content, attachments, captured_at
  FROM report_evidence
 WHERE report_id = ?
 ORDER BY seq;

-- name: InsertReportNote :exec
INSERT INTO report_notes (report_id, author_id, body)
VALUES (?, ?, ?);

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
