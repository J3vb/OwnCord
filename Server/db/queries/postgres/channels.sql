-- PostgreSQL variants of the sqlite channels queries.

-- name: ListChannels :many
SELECT id, name, type, COALESCE(category, '') AS category, COALESCE(topic, '') AS topic,
       position, slow_mode, archived, created_at,
       COALESCE(voice_max_users, 0) AS voice_max_users,
       voice_quality,
       mixing_threshold,
       COALESCE(voice_max_video, 0) AS voice_max_video
FROM channels ORDER BY position ASC, id ASC;

-- name: GetChannel :one
SELECT id, name, type, COALESCE(category, '') AS category, COALESCE(topic, '') AS topic,
       position, slow_mode, archived, created_at,
       COALESCE(voice_max_users, 0) AS voice_max_users,
       voice_quality,
       mixing_threshold,
       COALESCE(voice_max_video, 0) AS voice_max_video
FROM channels WHERE id = $1;

-- name: CreateChannel :one
INSERT INTO channels (name, type, category, topic, position)
VALUES ($1, $2, $3, $4, $5)
RETURNING id;

-- name: UpdateChannel :exec
UPDATE channels SET name = $1, topic = $2, slow_mode = $3 WHERE id = $4;

-- name: SetChannelSlowMode :exec
UPDATE channels SET slow_mode = $1 WHERE id = $2;

-- name: SetChannelVoiceMaxUsers :exec
UPDATE channels SET voice_max_users = $1 WHERE id = $2;

-- name: SetChannelVoiceMaxVideo :exec
UPDATE channels SET voice_max_video = $1 WHERE id = $2;

-- name: SetChannelVoiceQuality :exec
UPDATE channels SET voice_quality = $1 WHERE id = $2;

-- name: SetChannelMixingThreshold :exec
UPDATE channels SET mixing_threshold = $1 WHERE id = $2;

-- name: ArchiveChannel :exec
UPDATE channels SET archived = $1 WHERE id = $2;

-- name: DeleteChannel :exec
DELETE FROM channels WHERE id = $1;

-- name: AdminUpdateChannel :exec
UPDATE channels
SET name = $1, topic = $2, slow_mode = $3, position = $4, archived = $5
WHERE id = $6;

-- name: UpsertChannelPermission :exec
INSERT INTO channel_overrides (channel_id, role_id, allow, deny)
VALUES ($1, $2, $3, $4)
ON CONFLICT (channel_id, role_id) DO UPDATE SET
    allow = EXCLUDED.allow,
    deny  = EXCLUDED.deny;

-- name: GetChannelPermission :one
SELECT allow, deny FROM channel_overrides WHERE channel_id = $1 AND role_id = $2;

-- name: GetRoleChannelPermissions :many
SELECT channel_id, allow, deny FROM channel_overrides WHERE role_id = $1;

-- name: DeleteChannelPermission :exec
DELETE FROM channel_overrides WHERE channel_id = $1 AND role_id = $2;
