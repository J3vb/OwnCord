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
       vs.camera, vs.screenshare, vs.joined_at
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
WHERE vs.user_id = ?;

-- name: GetChannelVoiceStates :many
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare, vs.joined_at
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
WHERE vs.channel_id = ?
ORDER BY vs.joined_at ASC;

-- name: GetAllVoiceStates :many
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare, vs.joined_at
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
ORDER BY vs.channel_id, vs.joined_at ASC;

-- name: UpdateVoiceMute :exec
UPDATE voice_states SET muted = ? WHERE user_id = ?;

-- name: UpdateVoiceDeafen :exec
UPDATE voice_states SET deafened = ? WHERE user_id = ?;

-- name: UpdateVoiceSpeaking :exec
UPDATE voice_states SET speaking = ? WHERE user_id = ?;

-- name: UpdateVoiceCamera :exec
UPDATE voice_states SET camera = ? WHERE user_id = ?;

-- name: UpdateVoiceScreenshare :exec
UPDATE voice_states SET screenshare = ? WHERE user_id = ?;

-- name: EnableCameraIfUnderLimit :execresult
UPDATE voice_states SET camera = 1
WHERE voice_states.user_id = ? AND voice_states.channel_id = ?
  AND (SELECT COUNT(*) FROM voice_states AS vs2 WHERE vs2.channel_id = ? AND vs2.camera = 1) < ?;

-- name: ClearVoiceState :exec
DELETE FROM voice_states WHERE user_id = ?;

-- name: ClearAllVoiceStates :exec
DELETE FROM voice_states;

-- name: CountActiveCameras :one
SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND camera = 1;
