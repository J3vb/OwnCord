-- server_muted / server_deafened are deliberately absent from both upserts'
-- reset lists: a moderator-imposed mute must survive a channel switch, which
-- reaches the ON CONFLICT branch. It is scoped to the voice session:
-- leaving voice deletes the row, so a rejoin starts clean.

-- name: JoinVoiceChannel :exec
INSERT INTO voice_states (user_id, channel_id, muted, deafened, speaking, camera, screenshare, joined_at)
VALUES (?, ?, 0, 0, 0, 0, 0, ?)
ON CONFLICT(user_id) DO UPDATE SET
    channel_id  = excluded.channel_id,
    muted       = 0,
    deafened    = 0,
    speaking    = 0,
    camera      = 0,
    screenshare = 0,
    joined_at   = excluded.joined_at;

-- name: JoinVoiceChannelIfCapacity :execresult
-- The channel-wide row count excludes the joining user's own existing row
-- (if any), mirroring the OC-0081 fix on EnableCameraIfUnderLimit /
-- EnableScreenshareIfUnderLimit below. Without this, a user who already
-- holds a row on the target channel (e.g. retrying a join after a failed
-- channel-switch left their old row in place) gets counted against their
-- own capacity slot, so a full channel refuses an upsert that would only
-- replace the row already there (OC-0255).
INSERT INTO voice_states (user_id, channel_id, muted, deafened, speaking, camera, screenshare, joined_at)
SELECT ?, ?, 0, 0, 0, 0, 0, ?
WHERE (SELECT COUNT(*) FROM voice_states AS vs2 WHERE vs2.channel_id = ? AND vs2.user_id <> ?) < ?
ON CONFLICT(user_id) DO UPDATE SET
    channel_id  = excluded.channel_id,
    muted       = 0,
    deafened    = 0,
    speaking    = 0,
    camera      = 0,
    screenshare = 0,
    joined_at   = excluded.joined_at;

-- name: LeaveVoiceChannel :exec
DELETE FROM voice_states WHERE user_id = ?;

-- name: LeaveVoiceChannelIfMatch :execresult
DELETE FROM voice_states WHERE user_id = ? AND channel_id = ? AND joined_at = ?;

-- name: GetUserVoiceState :one
-- server_muted_by rides along here ONLY -- the single-user read RestoreModFlags
-- uses to carry a timeout's ownership across a channel switch (round 5,
-- Codex review P2) -- never on GetChannelVoiceStates/GetAllVoiceStates
-- below, which feed the client-facing voice_state/ready payloads: the
-- column is server-side-only (migration 049's comment) and must not leak
-- into the wire protocol.
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare,
       vs.server_muted, vs.server_deafened, vs.joined_at, vs.server_muted_by
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
WHERE vs.user_id = ?;

-- name: GetChannelVoiceStates :many
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare,
       vs.server_muted, vs.server_deafened, vs.joined_at
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
WHERE vs.channel_id = ?
ORDER BY vs.joined_at ASC;

-- name: GetAllVoiceStates :many
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare,
       vs.server_muted, vs.server_deafened, vs.joined_at
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
ORDER BY vs.channel_id, vs.joined_at ASC;

-- name: UpdateVoiceMute :exec
UPDATE voice_states SET muted = ? WHERE user_id = ?;

-- name: UpdateVoiceDeafen :exec
UPDATE voice_states SET deafened = ? WHERE user_id = ?;

-- name: UpdateVoiceCamera :exec
UPDATE voice_states SET camera = ? WHERE user_id = ?;

-- name: UpdateVoiceScreenshare :exec
UPDATE voice_states SET screenshare = ? WHERE user_id = ?;

-- Scoped to channel_id as well as user_id: the moderator's authorization is
-- checked against a channel snapshot several round trips before this write
-- lands, so an unscoped `WHERE user_id = ?` would follow the target onto
-- whatever channel their row points at by then -- including a DM call the
-- moderator was never authorized against (OC-0005). :execresult so the
-- caller can tell a real no-op (target moved) from a normal apply.

-- name: ApplyVoiceServerMute :execresult
-- server_muted_by = NULL unconditionally (round 5, Codex review P1): a
-- manual mute or re-mute must never leave a stale timeout id as owner --
-- otherwise that timeout's later lift would clear THIS independent manual
-- mute, which it does not own. A manual mute owns nothing (NULL), same as
-- ClearVoiceServerMute's own unmute.
UPDATE voice_states SET server_muted = 1, muted = 1, server_muted_by = NULL WHERE user_id = ? AND channel_id = ?;

-- name: ClearVoiceServerMute :execresult
-- server_muted_by is cleared unconditionally here too: this is the manual
-- moderator mute/unmute endpoint (voice_mod_mute), and an unmute through it
-- always wins regardless of who (if anyone, e.g. an active timeout) owns
-- the mute (round 4, Codex review, Part A) -- a later timeout lift then has
-- nothing left to find and does nothing, which is correct: the manual
-- unmute already spoke for the target's current state.
UPDATE voice_states SET server_muted = 0, server_muted_by = NULL WHERE user_id = ? AND channel_id = ?;

-- The timeout voice half's compare-and-mute (P1-3/P1-4 PARTIAL round 3;
-- reworked round 4, Codex review, to stamp ownership atomically -- see
-- migration 049's comment on voice_states.server_muted_by for the full
-- rationale). Scoped to channel_id AND joined_at, the join-instance token
-- JoinVoiceChannel already mints, so a leave-and-rejoin of the SAME channel
-- between authorization and this write also fails to match, not only a
-- channel switch -- one step tighter than ApplyVoiceServerMute/
-- ClearVoiceServerMute above, which voice_mod_mute has always scoped to
-- channel_id alone.

-- name: MuteForSession :execresult
-- The WHERE server_muted = 0 makes this ONE statement do what round 3 did
-- in two (read the prior state, then write): it matches a row only on a
-- genuine unmuted->muted transition, so RowsAffected alone tells the caller
-- whether server_muted_by (this action) is now the owner -- no separate
-- read, and no gap for a concurrent lift to land in between.
--
-- The second OR branch reclaims an ORPHANED mute (round 4, Codex review):
-- TimeoutUser's supersede-transfer (migration 049's comment) can only move
-- ownership off a row that has ALREADY stamped it -- if this timeout's own
-- supersede committed before the superseded row's mute had landed at all
-- (a real interleaving under the per-user lock: the superseded row's
-- MuteForTimeout call is still queued behind this one when TimeoutUser
-- transfers), the transfer finds nothing to move and voice_states is left
-- pointing at an action that is no longer active. Reclaiming here --
-- server_muted_by set to something NOT NULL and not one of the currently
-- active timeouts -- lets THIS call still claim ownership instead of
-- treating someone else's now-defunct mute as untouchable, so LiftTimeout
-- on THIS row can later clear it. NOT NULL excludes a manual moderator
-- mute (voice_mod_mute never sets server_muted_by): that ownership is never
-- reassigned to a timeout just because no timeout currently owns it.
--
-- The trailing EXISTS (round 5, Codex review P2) requires the INCOMING
-- action_id itself to still be an active timeout on THIS target: a mute
-- attempt that is only reaching the SFU/DB now because its own goroutine
-- was delayed, after its row was already lifted (and possibly a lift's
-- own finalize already ran), must not claim -- or re-claim -- a mute a
-- lift already correctly decided to clear. Without this a delayed A could
-- mute (or reclaim from B) under an owner the ledger no longer recognizes,
-- stranding the SFU muted until the reconcile sweep next runs.
UPDATE voice_states SET server_muted = 1, muted = 1, server_muted_by = sqlc.arg(action_id)
 WHERE user_id = sqlc.arg(user_id) AND channel_id = sqlc.arg(channel_id) AND joined_at = sqlc.arg(joined_at)
   AND (
     server_muted = 0
     OR (server_muted_by IS NOT NULL AND server_muted_by NOT IN (
       SELECT id FROM moderation_actions
        WHERE kind = 'timeout' AND lifted_at IS NULL AND expires_at > datetime('now')
     ))
   )
   AND EXISTS (
     SELECT 1 FROM moderation_actions
      WHERE id = sqlc.arg(action_id) AND target_id = sqlc.arg(user_id)
        AND kind = 'timeout' AND lifted_at IS NULL AND expires_at > datetime('now')
   );

-- name: VoiceSessionExists :one
-- Disambiguates MuteForSession's zero-rows-affected result: "no session"
-- (the target left/switched between authorization and this call, P1-3
-- PARTIAL) from "session exists but was already server-muted by
-- someone/something else" (not this action's ownership to claim).
SELECT EXISTS (
    SELECT 1 FROM voice_states WHERE user_id = ? AND channel_id = ? AND joined_at = ?
) AS found;

-- name: FindOrphanedVoiceMutes :many
-- The maintenance-tick (and start-up) reconcile sweep (round 4, B5-10
-- addendum): every voice_states row whose server_muted_by points at a
-- timeout that is now lifted or expired -- the crash window between a
-- lift's ledger commit and its post-commit voice-clear (service.
-- ModerationService.FinalizeTimeoutLift), and the gap this closes outright:
-- a timeout that simply EXPIRES, with nobody ever calling LiftTimeout, had
-- no unmute mechanism at all before this. A manual moderator mute
-- (server_muted_by NULL) is never a candidate.
SELECT vs.user_id, vs.server_muted_by AS action_id
  FROM voice_states vs
  JOIN moderation_actions ma ON ma.id = vs.server_muted_by
 WHERE vs.server_muted_by IS NOT NULL
   AND (ma.lifted_at IS NOT NULL OR ma.expires_at <= datetime('now'));

-- name: ApplyVoiceServerDeafen :execresult
UPDATE voice_states SET server_deafened = 1, deafened = 1 WHERE user_id = ? AND channel_id = ?;

-- name: ClearVoiceServerDeafen :execresult
UPDATE voice_states SET server_deafened = 0 WHERE user_id = ? AND channel_id = ?;

-- Camera and screenshare share one voice_max_video budget, counted in
-- STREAMS, not rows: a channel capped at N simultaneous video streams must
-- not let a camera publish ignore screenshare occupants (or vice versa,
-- OC-0023), and a single user with both flags set must consume two of the N
-- slots, not one (OC-0006) -- so both gates sum `vs2.camera + vs2.screenshare`
-- across the channel's rows rather than counting rows where either is set.
-- The enabling user's own bit for the flag being set CAN already be 1 at
-- gate time (a client that lost track of the server-side flag retries the
-- enable), so each gate excludes exactly that one bit from the count --
-- see the per-query comments below (OC-0081).

-- name: EnableCameraIfUnderLimit :execresult
-- The channel-wide stream count excludes the requester's own camera flag
-- (subtracted via the correlated outer-row reference), so re-enabling an
-- already-set camera is idempotent at the cap instead of being refused
-- against the requester's own stream (OC-0081). Their screenshare, and
-- every other user's streams, still count.
UPDATE voice_states SET camera = 1
WHERE voice_states.user_id = ? AND voice_states.channel_id = ?
  AND (SELECT COALESCE(SUM(vs2.camera), 0) + COALESCE(SUM(vs2.screenshare), 0) FROM voice_states AS vs2 WHERE vs2.channel_id = ?) - voice_states.camera < sqlc.arg(max_video);

-- name: EnableScreenshareIfUnderLimit :execresult
-- Mirror of EnableCameraIfUnderLimit: the count excludes the requester's
-- own screenshare flag so re-enable is idempotent at the cap (OC-0081).
UPDATE voice_states SET screenshare = 1
WHERE voice_states.user_id = ? AND voice_states.channel_id = ?
  AND (SELECT COALESCE(SUM(vs2.camera), 0) + COALESCE(SUM(vs2.screenshare), 0) FROM voice_states AS vs2 WHERE vs2.channel_id = ?) - voice_states.screenshare < sqlc.arg(max_video);

-- name: ClearVoiceState :exec
DELETE FROM voice_states WHERE user_id = ?;

-- name: ClearAllVoiceStates :exec
DELETE FROM voice_states;

-- name: CountActiveCameras :one
SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND camera = 1;
