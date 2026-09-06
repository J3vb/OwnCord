-- appeals is the B5-10 rate-limited appeal against a moderation action
-- (migration 050). Keep this file ASCII-only: sqlc v1.30 truncates the next
-- query by the byte/rune difference of any multi-byte character.

-- name: FindAppealForAction :one
-- The dedupe FAST PATH (mirrors reports' FindOpenOrAssignedReport): decision
-- 8 forbids re-appealing a decided appeal, and this table's UNIQUE(action_id)
-- forbids ANY second appeal against the same action, ever. This query alone
-- is a pre-check only and is not race-proof; the UNIQUE constraint on
-- InsertAppeal is what actually enforces it under concurrency.
SELECT id FROM appeals WHERE action_id = ? LIMIT 1;

-- name: InsertAppeal :one
-- public_id is generated in Go (crypto/rand) before this runs, the same
-- shape reports.public_id uses. A violation of UNIQUE(action_id) here is the
-- race-proof half of decision 8: two simultaneous appeals against the same
-- action both reach this INSERT, and the loser's violates the constraint.
INSERT INTO appeals (public_id, action_id, appellant_id, body)
VALUES (?, ?, ?, ?)
RETURNING id;

-- name: GetAppealByID :one
SELECT id, public_id, action_id, appellant_id, body, state, assignee_id,
       decided_by, decided_by_token, decision_note, created_at, decided_at
  FROM appeals WHERE id = ?;

-- name: GetAppealByPublicID :one
-- The only lookup a route parameter or a mod_queue frame's appeal_id ever
-- drives: public_id is the sole externally-visible identifier.
SELECT id, public_id, action_id, appellant_id, body, state, assignee_id,
       decided_by, decided_by_token, decision_note, created_at, decided_at
  FROM appeals WHERE public_id = ?;

-- name: ListAppealsMine :many
-- The appellant's own view: their appeals, newest first.
SELECT id, public_id, action_id, body, state, decision_note, created_at, decided_at
  FROM appeals
 WHERE appellant_id = ?
 ORDER BY created_at DESC, id DESC;

-- name: ListAppealsByState :many
-- The moderation queue view for one state ("open", "assigned", "decided" --
-- decided groups both terminal decision states together, mirroring reports'
-- "closed" grouping resolved/dismissed).
SELECT id, public_id, action_id, appellant_id, body, state, assignee_id,
       decided_by, decision_note, created_at, decided_at
  FROM appeals
 WHERE state = ?
 ORDER BY created_at DESC, id DESC;

-- name: ListAppealsOpenOrAssigned :many
-- The default queue view (state omitted): open and assigned together,
-- mirroring reports' ListReportsOpenOrAssigned.
SELECT id, public_id, action_id, appellant_id, body, state, assignee_id,
       decided_by, decision_note, created_at, decided_at
  FROM appeals
 WHERE state IN ('open', 'assigned')
 ORDER BY created_at DESC, id DESC;

-- name: ListAppealsDecided :many
SELECT id, public_id, action_id, appellant_id, body, state, assignee_id,
       decided_by, decision_note, created_at, decided_at
  FROM appeals
 WHERE state IN ('upheld', 'overturned')
 ORDER BY created_at DESC, id DESC;

-- name: AssignAppeal :execrows
-- Guarded three ways, the same shape as reports' AssignReport: state (only
-- 'open' may be assigned -- nothing leaves a decided or withdrawn state),
-- the OBSERVED assignee (optimistic concurrency), and EXISTS(users) (a
-- moderator erased between requirePerm and this write cannot land as the
-- new assignee).
UPDATE appeals
   SET assignee_id = sqlc.arg(assignee_id), state = 'assigned'
 WHERE appeals.id = sqlc.arg(id)
   AND appeals.state IN ('open', 'assigned')
   AND appeals.assignee_id = sqlc.arg(observed_assignee_id)
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(assignee_id));

-- name: DecideAppeal :execrows
-- new_state is 'upheld' or 'overturned', validated in Go. Guarded to
-- open/assigned states -- nothing leaves a decided or withdrawn state -- and
-- EXISTS(users) for the deciding moderator (erased mid-flight cannot land).
UPDATE appeals
   SET state = sqlc.arg(new_state), decided_by = sqlc.arg(decided_by),
       decision_note = sqlc.arg(decision_note), decided_at = datetime('now')
 WHERE appeals.id = sqlc.arg(id)
   AND appeals.state IN ('open', 'assigned')
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(decided_by));

-- name: WithdrawAppeal :execrows
-- The appellant only, guarded to open/assigned states.
UPDATE appeals
   SET state = 'withdrawn'
 WHERE id = ? AND appellant_id = ? AND state IN ('open', 'assigned');

-- name: CountUsersWithPermission :one
-- The eligible-moderator count for decision 8's self-review escape: every
-- user (other than exclude_id, the acting moderator) whose role holds
-- perm_bit or the Administrator bit. The bit test is done in SQL rather
-- than fetched row-by-row and checked in Go, since the count alone is all
-- the caller needs.
SELECT COUNT(*) FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE u.id != sqlc.arg(exclude_id)
   AND ((r.permissions & sqlc.arg(perm_bit)) != 0 OR (r.permissions & sqlc.arg(admin_bit)) != 0);

-- name: RetireRetiredCandidatesExcludingAppealed :execrows
-- B5-10's completion of the // B5-10: comment RetireModerationActions left
-- in Server/db/moderation_action_queries.go: the same warning/timeout
-- retention sweep as RetireRetiredCandidates (moderation_actions.sql), but
-- excluding any id an appeals row references -- decision 8's UNIQUE(action_id)
-- memory must not be swept out from under a decided appeal, or a fresh
-- appeal against the same action could slip past the "one appeal per action,
-- ever" rule the row alone enforces.
DELETE FROM moderation_actions
 WHERE ((kind = 'warning' AND acknowledged_at IS NOT NULL AND acknowledged_at < sqlc.arg(cutoff))
    OR (kind = 'timeout' AND COALESCE(lifted_at, expires_at) < sqlc.arg(cutoff)))
   AND id NOT IN (SELECT action_id FROM appeals);

-- name: UnlinkAppealsByDecider :exec
-- Erasure's actor-token unlink (mirrors UnlinkModerationActionsByActor): an
-- erased moderator's decisions keep their row, decision and order, but the
-- deciding id goes to 0 and the token takes its place.
UPDATE appeals SET decided_by = 0, decided_by_token = ? WHERE decided_by = ?;

-- name: UnlinkAppealsByAssignee :exec
-- Same, for assignee_id: no token column of its own (mirrors reports'
-- assignee_id and moderation_actions.lifted_by), so an erased assignee's id
-- simply goes to 0.
UPDATE appeals SET assignee_id = 0 WHERE assignee_id = ?;
