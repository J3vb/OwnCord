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
INSERT INTO voice_states (user_id, channel_id, muted, deafened, speaking, camera, screenshare, joined_at)
SELECT ?, ?, 0, 0, 0, 0, 0, ?
WHERE (SELECT COUNT(*) FROM voice_states AS vs2 WHERE vs2.channel_id = ?) < ?
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
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare,
       vs.server_muted, vs.server_deafened, vs.joined_at
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
UPDATE voice_states SET server_muted = 1, muted = 1 WHERE user_id = ? AND channel_id = ?;

-- name: ClearVoiceServerMute :execresult
UPDATE voice_states SET server_muted = 0 WHERE user_id = ? AND channel_id = ?;

-- name: ApplyVoiceServerDeafen :execresult
UPDATE voice_states SET server_deafened = 1, deafened = 1 WHERE user_id = ? AND channel_id = ?;

-- name: ClearVoiceServerDeafen :execresult
UPDATE voice_states SET server_deafened = 0 WHERE user_id = ? AND channel_id = ?;

-- Camera and screenshare share one voice_max_video budget: a channel capped
-- at N simultaneous video streams must not let a camera publish ignore
-- screenshare occupants (or vice versa), so both gates count the same
-- `camera = 1 OR screenshare = 1` slot usage (OC-0023).

-- name: EnableCameraIfUnderLimit :execresult
UPDATE voice_states SET camera = 1
WHERE voice_states.user_id = ? AND voice_states.channel_id = ?
  AND (SELECT COUNT(*) FROM voice_states AS vs2 WHERE vs2.channel_id = ? AND (vs2.camera = 1 OR vs2.screenshare = 1)) < ?;

-- name: EnableScreenshareIfUnderLimit :execresult
UPDATE voice_states SET screenshare = 1
WHERE voice_states.user_id = ? AND voice_states.channel_id = ?
  AND (SELECT COUNT(*) FROM voice_states AS vs2 WHERE vs2.channel_id = ? AND (vs2.camera = 1 OR vs2.screenshare = 1)) < ?;

-- name: ClearVoiceState :exec
DELETE FROM voice_states WHERE user_id = ?;

-- name: ClearAllVoiceStates :exec
DELETE FROM voice_states;

-- name: CountActiveCameras :one
SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND camera = 1;
