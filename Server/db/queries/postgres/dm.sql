-- PostgreSQL variants of the sqlite DM queries.
-- InsertDMChannel: sqlite uses :execresult (LastInsertId); postgres uses
-- :one with RETURNING id.
-- `INSERT OR IGNORE` becomes `INSERT ... ON CONFLICT DO NOTHING`.

-- name: InsertDMChannel :one
INSERT INTO channels (name, type) VALUES ('', 'dm') RETURNING id;

-- name: InsertDMParticipants :exec
INSERT INTO dm_participants (channel_id, user_id) VALUES ($1, $2), ($3, $4);

-- name: InsertDMOpenState :exec
INSERT INTO dm_open_state (user_id, channel_id) VALUES ($1, $2), ($3, $4)
ON CONFLICT (user_id, channel_id) DO NOTHING;

-- name: FindExistingDMChannel :one
SELECT dp1.channel_id
FROM dm_participants dp1
JOIN dm_participants dp2 ON dp1.channel_id = dp2.channel_id
JOIN channels c ON c.id = dp1.channel_id
WHERE dp1.user_id = $1 AND dp2.user_id = $2 AND c.type = 'dm'
LIMIT 1;

-- name: OpenDM :exec
INSERT INTO dm_open_state (user_id, channel_id) VALUES ($1, $2)
ON CONFLICT (user_id, channel_id) DO NOTHING;

-- name: CloseDM :exec
DELETE FROM dm_open_state WHERE user_id = $1 AND channel_id = $2;

-- name: IsDMParticipant :one
SELECT user_id FROM dm_participants WHERE user_id = $1 AND channel_id = $2;

-- name: GetDMParticipantIDs :many
SELECT user_id FROM dm_participants WHERE channel_id = $1;

-- For the "last message at" and "last message content" columns, sqlite
-- COALESCEs to '' (empty string). Postgres TIMESTAMPTZ cannot COALESCE to an
-- empty string, so we COALESCE to the dm_open_state.opened_at fallback and
-- leave conversion to the store wrapper.
-- name: GetUserDMChannels :many
SELECT
    c.id                                          AS channel_id,
    u.id                                          AS recipient_id,
    u.username                                    AS recipient_username,
    COALESCE(u.avatar, '')                        AS recipient_avatar,
    u.status                                      AS recipient_status,
    lm.id                                         AS last_message_id,
    COALESCE(lm.content, '')                      AS last_message,
    COALESCE(lm.timestamp, dos.opened_at)         AS last_message_at,
    COUNT(CASE WHEN m_unread.id > COALESCE(rs.last_message_id, 0)
               AND m_unread.deleted = FALSE THEN 1 END) AS unread_count
FROM dm_open_state dos
JOIN channels c          ON c.id = dos.channel_id AND c.type = 'dm'
JOIN dm_participants dp  ON dp.channel_id = c.id AND dp.user_id != $1
JOIN users u             ON u.id = dp.user_id
LEFT JOIN messages lm    ON lm.id = (
    SELECT MAX(id) FROM messages WHERE channel_id = c.id AND deleted = FALSE
)
LEFT JOIN messages m_unread ON m_unread.channel_id = c.id
LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = $2
WHERE dos.user_id = $3
GROUP BY c.id, u.id, lm.id, lm.content, lm.timestamp, dos.opened_at
ORDER BY COALESCE(lm.timestamp, dos.opened_at) DESC;
