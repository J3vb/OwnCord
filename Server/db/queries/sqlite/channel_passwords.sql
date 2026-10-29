-- Optional password on a voice channel (migration 086). password_hash never
-- leaves the server: the channel list queries do not select it, and only the
-- join check reads it, through GetChannelPasswordState.

-- name: SetChannelPassword :execrows
UPDATE channels
SET password_hash = sqlc.arg(password_hash), password_version = password_version + 1
WHERE id = sqlc.arg(id) AND type = 'voice';

-- name: ClearChannelPassword :execrows
UPDATE channels
SET password_hash = NULL, password_version = password_version + 1
WHERE id = ? AND type = 'voice' AND password_hash IS NOT NULL;

-- name: GetChannelPasswordState :one
SELECT password_hash, password_version FROM channels WHERE id = ?;

-- name: HasChannelPasswordGrant :one
SELECT COUNT(*) FROM channel_password_grants g
JOIN channels c ON c.id = g.channel_id
WHERE g.channel_id = sqlc.arg(channel_id) AND g.user_id = sqlc.arg(user_id)
  AND c.password_hash IS NOT NULL AND g.password_version = c.password_version;

-- name: GrantChannelPassword :execrows
INSERT INTO channel_password_grants (channel_id, user_id, password_version, granted_at)
SELECT c.id, sqlc.arg(user_id), c.password_version, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
FROM channels c
WHERE c.id = sqlc.arg(channel_id) AND c.password_hash IS NOT NULL AND c.password_version = sqlc.arg(password_version)
ON CONFLICT (channel_id, user_id) DO UPDATE
SET password_version = excluded.password_version, granted_at = excluded.granted_at;
