-- name: ListChannels :many
SELECT c.id, c.name, c.type, COALESCE(cc.name, '') AS category,
       COALESCE(c.category_id, 0) AS category_id,
       COALESCE(cc.position, 0) AS category_position,
       COALESCE(c.topic, '') AS topic,
       c.position,
       CAST(CASE WHEN p.id IS NULL THEN c.slow_mode ELSE p.slow_mode END AS INTEGER) AS slow_mode,
       CAST(CASE WHEN p.id IS NULL THEN c.archived ELSE p.archived END AS INTEGER) AS archived,
       c.created_at,
       COALESCE(c.voice_max_users, 0) AS voice_max_users,
       c.voice_quality,
       c.mixing_threshold,
       COALESCE(c.voice_max_video, 0) AS voice_max_video,
       CAST(CASE WHEN p.id IS NULL THEN c.nsfw ELSE p.nsfw END AS INTEGER) AS nsfw,
       c.afk,
       COALESCE(c.parent_channel_id, 0) AS parent_channel_id,
       c.thread_archived,
       c.thread_locked,
       c.forum_require_tag,
       c.forum_default_auto_archive_minutes,
       CAST(c.password_hash IS NOT NULL AS INTEGER) AS join_locked
FROM channels c
LEFT JOIN channels p ON p.id = c.parent_channel_id
LEFT JOIN channel_categories cc ON cc.id = c.category_id
WHERE c.parent_channel_id IS NULL
ORDER BY c.position ASC, c.id ASC;

-- name: GetChannel :one
SELECT c.id, c.name, c.type, COALESCE(cc.name, '') AS category,
       COALESCE(c.category_id, 0) AS category_id,
       COALESCE(cc.position, 0) AS category_position,
       COALESCE(c.topic, '') AS topic,
       c.position,
       CAST(CASE WHEN p.id IS NULL THEN c.slow_mode ELSE p.slow_mode END AS INTEGER) AS slow_mode,
       CAST(CASE WHEN p.id IS NULL THEN c.archived ELSE p.archived END AS INTEGER) AS archived,
       c.created_at,
       COALESCE(c.voice_max_users, 0) AS voice_max_users,
       c.voice_quality,
       c.mixing_threshold,
       COALESCE(c.voice_max_video, 0) AS voice_max_video,
       CAST(CASE WHEN p.id IS NULL THEN c.nsfw ELSE p.nsfw END AS INTEGER) AS nsfw,
       c.afk,
       COALESCE(c.parent_channel_id, 0) AS parent_channel_id,
       c.thread_archived,
       c.thread_locked,
       c.forum_require_tag,
       c.forum_default_auto_archive_minutes,
       CAST(c.password_hash IS NOT NULL AS INTEGER) AS join_locked
FROM channels c
LEFT JOIN channels p ON p.id = c.parent_channel_id
LEFT JOIN channel_categories cc ON cc.id = c.category_id WHERE c.id = ?;

-- name: GetAFKChannel :one
SELECT c.id, c.name, c.type, COALESCE(cc.name, '') AS category,
       COALESCE(c.category_id, 0) AS category_id,
       COALESCE(cc.position, 0) AS category_position,
       COALESCE(c.topic, '') AS topic,
       c.position,
       CAST(CASE WHEN p.id IS NULL THEN c.slow_mode ELSE p.slow_mode END AS INTEGER) AS slow_mode,
       CAST(CASE WHEN p.id IS NULL THEN c.archived ELSE p.archived END AS INTEGER) AS archived,
       c.created_at,
       COALESCE(c.voice_max_users, 0) AS voice_max_users,
       c.voice_quality,
       c.mixing_threshold,
       COALESCE(c.voice_max_video, 0) AS voice_max_video,
       CAST(CASE WHEN p.id IS NULL THEN c.nsfw ELSE p.nsfw END AS INTEGER) AS nsfw,
       c.afk,
       COALESCE(c.parent_channel_id, 0) AS parent_channel_id,
       c.thread_archived,
       c.thread_locked,
       c.forum_require_tag,
       c.forum_default_auto_archive_minutes,
       CAST(c.password_hash IS NOT NULL AS INTEGER) AS join_locked
FROM channels c
LEFT JOIN channels p ON p.id = c.parent_channel_id
LEFT JOIN channel_categories cc ON cc.id = c.category_id WHERE c.afk = 1;

-- name: ClearAFKChannel :exec
UPDATE channels SET afk = 0 WHERE afk = 1;

-- name: SetChannelAFK :execrows
UPDATE channels SET afk = 1 WHERE id = ? AND type = 'voice' AND archived = 0;

-- name: CreateChannel :execresult
INSERT INTO channels (name, type, category_id, topic, position) VALUES (?, ?, ?, ?, ?);

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
SET name = ?, topic = ?, category_id = ?, slow_mode = ?, position = ?, archived = ?,
    nsfw = ?, voice_max_users = ?, voice_max_video = ?
WHERE id = ?;

-- name: UpsertChannelPermission :exec
INSERT INTO channel_overrides (channel_id, role_id, allow, deny)
VALUES (?, ?, ?, ?)
ON CONFLICT(channel_id, role_id) DO UPDATE SET
    allow = excluded.allow,
    deny  = excluded.deny;

-- name: GetChannelPermission :one
-- The single-channel override reads resolve a thread id to its parent first
-- (migration 074): a thread has no overrides of its own, it has its parent's.
SELECT allow, deny FROM channel_overrides
WHERE channel_id = (
    SELECT COALESCE(ac.parent_channel_id, ac.id) FROM channels ac WHERE ac.id = sqlc.arg(channel_id))
  AND role_id = sqlc.arg(role_id);

-- name: GetChannelOverrides :many
SELECT role_id, allow, deny FROM channel_overrides WHERE channel_id = (
    SELECT COALESCE(ac.parent_channel_id, ac.id) FROM channels ac WHERE ac.id = sqlc.arg(channel_id));

-- name: GetRoleChannelPermissions :many
SELECT channel_id, allow, deny FROM channel_overrides WHERE role_id = ?;

-- name: ListHeldRoleChannelOverrides :many
-- Every channel override of every role the member holds, one row per
-- (channel, role). The per-role rows are what GetMemberGrants composes.
SELECT co.channel_id, co.role_id, co.allow, co.deny
FROM channel_overrides co
JOIN user_roles ur ON ur.role_id = co.role_id
WHERE ur.user_id = ?;

-- name: DeleteChannelPermission :exec
DELETE FROM channel_overrides WHERE channel_id = ? AND role_id = ?;

-- name: UpsertChannelUserPermission :exec
INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny)
VALUES (?, ?, ?, ?)
ON CONFLICT(channel_id, user_id) DO UPDATE SET
    allow = excluded.allow,
    deny  = excluded.deny;

-- name: GetChannelUserPermission :one
SELECT allow, deny FROM channel_user_overrides
WHERE channel_id = (
    SELECT COALESCE(ac.parent_channel_id, ac.id) FROM channels ac WHERE ac.id = sqlc.arg(channel_id))
  AND user_id = sqlc.arg(user_id);

-- name: GetChannelUserOverrides :many
SELECT user_id, allow, deny FROM channel_user_overrides WHERE channel_id = (
    SELECT COALESCE(ac.parent_channel_id, ac.id) FROM channels ac WHERE ac.id = sqlc.arg(channel_id));

-- name: GetUserChannelPermissions :many
SELECT channel_id, allow, deny FROM channel_user_overrides WHERE user_id = ?;

-- name: DeleteChannelUserPermission :exec
DELETE FROM channel_user_overrides WHERE channel_id = ? AND user_id = ?;
