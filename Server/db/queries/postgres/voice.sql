-- PostgreSQL variants of the sqlite voice queries.
-- voice_states boolean columns (muted, deafened, speaking, camera,
-- screenshare) use FALSE/TRUE instead of 0/1.

-- name: JoinVoiceChannel :exec
INSERT INTO voice_states (user_id, channel_id, muted, deafened, speaking, camera, screenshare, joined_at)
VALUES ($1, $2, FALSE, FALSE, FALSE, FALSE, FALSE, $3)
ON CONFLICT (user_id) DO UPDATE SET
    channel_id  = EXCLUDED.channel_id,
    muted       = FALSE,
    deafened    = FALSE,
    speaking    = FALSE,
    camera      = FALSE,
    screenshare = FALSE,
    joined_at   = EXCLUDED.joined_at;

-- name: JoinVoiceChannelIfCapacity :execrows
INSERT INTO voice_states (user_id, channel_id, muted, deafened, speaking, camera, screenshare, joined_at)
SELECT $1, $2, FALSE, FALSE, FALSE, FALSE, FALSE, $3
WHERE (SELECT COUNT(*) FROM voice_states AS vs2 WHERE vs2.channel_id = $4) < $5
ON CONFLICT (user_id) DO UPDATE SET
    channel_id  = EXCLUDED.channel_id,
    muted       = FALSE,
    deafened    = FALSE,
    speaking    = FALSE,
    camera      = FALSE,
    screenshare = FALSE,
    joined_at   = EXCLUDED.joined_at;

-- name: LeaveVoiceChannel :exec
DELETE FROM voice_states WHERE user_id = $1;

-- name: LeaveVoiceChannelIfMatch :execrows
DELETE FROM voice_states WHERE user_id = $1 AND channel_id = $2 AND joined_at = $3;

-- name: GetUserVoiceState :one
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare, vs.joined_at
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
WHERE vs.user_id = $1;

-- name: GetChannelVoiceStates :many
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare, vs.joined_at
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
WHERE vs.channel_id = $1
ORDER BY vs.joined_at ASC;

-- name: GetAllVoiceStates :many
SELECT vs.user_id, vs.channel_id, u.username,
       vs.muted, vs.deafened, vs.speaking,
       vs.camera, vs.screenshare, vs.joined_at
FROM voice_states vs
JOIN users u ON u.id = vs.user_id
ORDER BY vs.channel_id, vs.joined_at ASC;

-- name: UpdateVoiceMute :exec
UPDATE voice_states SET muted = $1 WHERE user_id = $2;

-- name: UpdateVoiceDeafen :exec
UPDATE voice_states SET deafened = $1 WHERE user_id = $2;

-- name: UpdateVoiceSpeaking :exec
UPDATE voice_states SET speaking = $1 WHERE user_id = $2;

-- name: UpdateVoiceCamera :exec
UPDATE voice_states SET camera = $1 WHERE user_id = $2;

-- name: UpdateVoiceScreenshare :exec
UPDATE voice_states SET screenshare = $1 WHERE user_id = $2;

-- name: EnableCameraIfUnderLimit :execrows
UPDATE voice_states SET camera = TRUE
WHERE voice_states.user_id = $1 AND voice_states.channel_id = $2
  AND (SELECT COUNT(*) FROM voice_states AS vs2 WHERE vs2.channel_id = $3 AND vs2.camera = TRUE) < $4;

-- name: ClearVoiceState :exec
DELETE FROM voice_states WHERE user_id = $1;

-- name: ClearAllVoiceStates :exec
DELETE FROM voice_states;

-- name: CountActiveCameras :one
SELECT COUNT(*) FROM voice_states WHERE channel_id = $1 AND camera = TRUE;
