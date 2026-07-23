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
FROM channels WHERE id = ?;

-- name: CreateChannel :execresult
INSERT INTO channels (name, type, category, topic, position) VALUES (?, ?, ?, ?, ?);

-- name: UpdateChannel :exec
UPDATE channels SET name = ?, topic = ?, slow_mode = ? WHERE id = ?;

-- name: SetChannelSlowMode :exec
UPDATE channels SET slow_mode = ? WHERE id = ?;

-- name: SetChannelVoiceMaxUsers :exec
UPDATE channels SET voice_max_users = ? WHERE id = ?;

-- name: DeleteChannel :exec
DELETE FROM channels WHERE id = ?;

-- name: AdminUpdateChannel :exec
UPDATE channels
SET name = ?, topic = ?, slow_mode = ?, position = ?, archived = ?
WHERE id = ?;

-- name: UpsertChannelPermission :exec
INSERT INTO channel_overrides (channel_id, role_id, allow, deny)
VALUES (?, ?, ?, ?)
ON CONFLICT(channel_id, role_id) DO UPDATE SET
    allow = excluded.allow,
    deny  = excluded.deny;

-- name: GetChannelPermission :one
SELECT allow, deny FROM channel_overrides WHERE channel_id = ? AND role_id = ?;

-- name: GetRoleChannelPermissions :many
SELECT channel_id, allow, deny FROM channel_overrides WHERE role_id = ?;

-- name: DeleteChannelPermission :exec
DELETE FROM channel_overrides WHERE channel_id = ? AND role_id = ?;
