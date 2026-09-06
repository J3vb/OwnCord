-- moderation_actions is the B5-9 moderator-action ledger (migration 049):
-- every warning, timeout, kick, ban and removal writes a row here. Keep
-- this file ASCII-only: sqlc v1.30 truncates the next query by the
-- byte/rune difference of any multi-byte character.

-- name: InsertModerationAction :one
-- The rank guard (actor strictly outranks target, re-read live) runs in Go
-- immediately before this insert, inside the same transaction as the
-- caller's effect (Server/db/moderation_action_queries.go,
-- recordModerationAction) -- not here, so this statement is a plain insert.
INSERT INTO moderation_actions (kind, target_id, actor_id, report_id, reason, expires_at)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING id;

-- name: HasActiveTimeout :one
-- The one indexed lookup permissions.Checker / service.PermissionService.Subject
-- run, uncached, to fill Subject.TimedOut.
SELECT EXISTS (
    SELECT 1 FROM moderation_actions
     WHERE target_id = ? AND kind = 'timeout' AND lifted_at IS NULL AND expires_at > datetime('now')
) AS active;

-- name: GetActiveTimeout :one
-- The active timeout row itself, for LiftTimeout's guard.
SELECT id, target_id, actor_id, report_id, reason, expires_at, created_at
  FROM moderation_actions
 WHERE target_id = ? AND kind = 'timeout' AND lifted_at IS NULL AND expires_at > datetime('now')
 ORDER BY id DESC
 LIMIT 1;

-- name: LiftTimeout :execrows
-- Guarded on EXISTS(users) for the lifting actor, same shape as the report
-- queries' moderator-erased-mid-flight guard.
UPDATE moderation_actions
   SET lifted_at = datetime('now'), lifted_by = sqlc.arg(lifted_by)
 WHERE moderation_actions.id = sqlc.arg(action_id)
   AND kind = 'timeout'
   AND lifted_at IS NULL
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(lifted_by));

-- name: ListUnacknowledgedWarnings :many
-- ready's notices slot: every warning issued to userID that has not yet
-- been acknowledged.
SELECT id, kind, reason, created_at
  FROM moderation_actions
 WHERE target_id = ? AND kind = 'warning' AND acknowledged_at IS NULL
 ORDER BY created_at;

-- name: AcknowledgeWarning :execrows
-- Own rows only: userID must be the target. Zero rows affected means the
-- id does not exist, belongs to someone else, or is already acknowledged --
-- the caller answers the same NOT_FOUND either way, so this can never be
-- used to probe another user's warning ids.
UPDATE moderation_actions
   SET acknowledged_at = datetime('now')
 WHERE id = ? AND target_id = ? AND kind = 'warning' AND acknowledged_at IS NULL;

-- name: ListModerationActionsForTarget :many
-- GET /api/v1/moderation/users/{id}/actions: the full ledger for one user,
-- newest first.
SELECT id, kind, target_id, actor_id, actor_token, report_id, reason,
       expires_at, acknowledged_at, lifted_at, lifted_by, created_at
  FROM moderation_actions
 WHERE target_id = ?
 ORDER BY created_at DESC, id DESC;

-- name: ListModerationActionsForReport :many
-- The queue detail's "actions taken" list.
SELECT id, kind, target_id, actor_id, actor_token, report_id, reason,
       expires_at, acknowledged_at, lifted_at, lifted_by, created_at
  FROM moderation_actions
 WHERE report_id = ?
 ORDER BY created_at, id;

-- name: RetireRetiredCandidates :execrows
-- The maintenance-tick retention sweep, run only when no appeals table
-- exists yet (B5-9; B5-10's migration 050 adds appeals and this query is
-- replaced by one that excludes referenced ids -- see the // B5-10: comment
-- in Server/db/moderation_action_queries.go). Warnings retire
-- moderation.action_retention_days after acknowledged_at; timeouts the same
-- number of days after expires_at, or after lifted_at when lifted early.
-- Ban, kick and removal rows are never touched here.
DELETE FROM moderation_actions
 WHERE (kind = 'warning' AND acknowledged_at IS NOT NULL AND acknowledged_at < sqlc.arg(cutoff))
    OR (kind = 'timeout' AND COALESCE(lifted_at, expires_at) < sqlc.arg(cutoff));

-- name: UnlinkModerationActionsByActor :exec
-- Erasure's actor-token unlink (mirrors erasureUnlinkReports): an erased
-- moderator's actions keep their row, action, time and order, but the
-- actor id goes to 0 and the token takes its place.
UPDATE moderation_actions SET actor_id = 0, actor_token = ? WHERE actor_id = ?;

-- name: UnlinkModerationActionsByLifter :exec
-- Same, for the lifted_by column: no token column of its own (mirrors the
-- reports assignee_id and audit_log's other bare actor columns), so an
-- erased lifter's id simply goes to 0.
UPDATE moderation_actions SET lifted_by = 0 WHERE lifted_by = ?;
