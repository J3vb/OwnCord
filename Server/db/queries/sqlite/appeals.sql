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
-- N4 review: INSERT ... SELECT ... WHERE EXISTS, the same shape reports'
-- InsertReport uses, so an action erased between Submit's ownership lookup
-- and this write (the target's account erasure cascades and removes the
-- action row) surfaces as zero rows (mapped to db.ErrNotFound) rather than
-- a raw foreign-key constraint error reaching the caller as a 500.
INSERT INTO appeals (public_id, action_id, appellant_id, body)
SELECT sqlc.arg(public_id), sqlc.arg(action_id), sqlc.arg(appellant_id), sqlc.arg(body)
 WHERE EXISTS (SELECT 1 FROM moderation_actions WHERE id = sqlc.arg(action_id))
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

-- name: AppealObservedRowExists :one
-- P3 review: reject a stale/terminal appeal BEFORE running the (possibly
-- expensive) self-review eligibility test below -- the exact row+state+
-- assignee the caller observed, mirroring DecideAppeal's own guard so a
-- decide that is going to fail its guarded UPDATE anyway never pays for the
-- eligibility check first.
SELECT EXISTS (
  SELECT 1 FROM appeals
   WHERE id = sqlc.arg(id) AND state IN ('open', 'assigned')
     AND state = sqlc.arg(observed_state) AND assignee_id = sqlc.arg(observed_assignee_id)
);

-- name: DecideAppeal :execrows
-- new_state is 'upheld' or 'overturned', validated in Go. Guarded on the
-- OBSERVED state and assignee (optimistic concurrency, Claim 5 review: a
-- bare "state IN ('open','assigned')" let an Assign and a Decide the caller
-- read as sequential actually land out of order -- Assign after the caller
-- read 'open' but before this write, or vice versa, both invisible to a
-- guard that does not pin the exact row the caller observed), and
-- EXISTS(users) for the deciding moderator (erased mid-flight cannot land).
UPDATE appeals
   SET state = sqlc.arg(new_state), decided_by = sqlc.arg(decided_by),
       decision_note = sqlc.arg(decision_note), decided_at = datetime('now')
 WHERE appeals.id = sqlc.arg(id)
   AND appeals.state IN ('open', 'assigned')
   AND appeals.state = sqlc.arg(observed_state)
   AND appeals.assignee_id = sqlc.arg(observed_assignee_id)
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = sqlc.arg(decided_by));

-- name: WithdrawAppeal :execrows
-- The appellant only, guarded to open/assigned states.
UPDATE appeals
   SET state = 'withdrawn'
 WHERE id = ? AND appellant_id = ? AND state IN ('open', 'assigned');

-- name: CountUsersWithPermission :one
-- The eligible-moderator COUNT for decision 8's self-review escape (the
-- exported db.CountEligibleModerators contract -- Assign's non-transactional
-- checkSelfReview and its own direct tests want the actual count, not just
-- ">0"): every OTHER user, excluding the acting moderator, the appellant
-- (F2/F3 review: an appellant who happens to also hold the bit must never
-- count as their own alternative reviewer), id 0 (the system actor is never
-- a reviewer), and anyone effectively banned, who holds perm_bit or the
-- Administrator bit. The ban comparison is normalised the same way
-- mention_queries.go's notBannedClause is (P2 review, uniformity): BanUser
-- writes ISO-8601 'Z' ("2006-01-02T15:04:05Z"), and a raw lexical
-- "ban_expires <= datetime('now')" compares that against SQLite's space-form
-- "2006-01-02 15:04:05" -- a bare ' ' sorts BELOW 'T', so a same-day expiry
-- would compare as still-active until midnight and wrongly exclude an
-- eligible moderator (the exact bug notBannedClause's own comment
-- documents). replace() normalises the separator before comparing.
SELECT COUNT(*) FROM users u
  JOIN roles r ON r.id = u.role_id
 WHERE u.id != 0
   AND u.id != sqlc.arg(exclude_actor_id)
   AND u.id != sqlc.arg(exclude_appellant_id)
   AND (u.banned = 0 OR (u.ban_expires IS NOT NULL AND replace(u.ban_expires, ' ', 'T') <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
   AND ((r.permissions & sqlc.arg(perm_bit)) != 0 OR (r.permissions & sqlc.arg(admin_bit)) != 0);

-- name: EligibleModeratorExists :one
-- DecideAppealTx's own self-review escape test (P3 review): the identical
-- WHERE clause as CountUsersWithPermission above, but SELECT EXISTS rather
-- than SELECT COUNT(*) -- DecideAppealTx only ever tests ">0", so scanning
-- until the first match is strictly less work than counting every match,
-- and it now runs only after AppealObservedRowExists has already confirmed
-- the appeal is not stale/terminal, inside the same transaction.
SELECT EXISTS (
  SELECT 1 FROM users u
    JOIN roles r ON r.id = u.role_id
   WHERE u.id != 0
     AND u.id != sqlc.arg(exclude_actor_id)
     AND u.id != sqlc.arg(exclude_appellant_id)
     AND (u.banned = 0 OR (u.ban_expires IS NOT NULL AND replace(u.ban_expires, ' ', 'T') <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
     AND ((r.permissions & sqlc.arg(perm_bit)) != 0 OR (r.permissions & sqlc.arg(admin_bit)) != 0)
);

-- name: LiftTimeoutByActionID :execrows
-- F1/N1 review: overturning an appeal reverses the SPECIFIC appealed action,
-- never "whatever timeout is active for this target now" -- two timeouts,
-- appeal the older, overturn must not touch a newer one. Guarded on id AND
-- still-active (lifted_at IS NULL AND expires_at > now): if this row was
-- already lifted (expired naturally, lifted directly, or superseded by a
-- later TimeoutUser call, N1) overturning it is a record only, zero rows
-- affected, not an error. Runs under the system actor (0, no EXISTS(users)
-- guard): the reversal is a mechanical consequence of the appeal DECISION,
-- audited on the appeal row with the human decider's id -- it is not a
-- second moderation action by that human, so 0 is a blessed sentinel here
-- rather than a live user id needing re-validation.
UPDATE moderation_actions
   SET lifted_at = datetime('now'), lifted_by = 0
 WHERE id = sqlc.arg(id) AND kind = 'timeout' AND lifted_at IS NULL AND expires_at > datetime('now');

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
