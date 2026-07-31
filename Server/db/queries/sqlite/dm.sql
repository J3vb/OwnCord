-- name: OpenDM :exec
INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?);

-- name: CloseDM :exec
DELETE FROM dm_open_state WHERE user_id = ? AND channel_id = ?;

-- name: IsDMParticipant :one
SELECT user_id FROM dm_participants WHERE user_id = ? AND channel_id = ?;

-- name: GetDMParticipantIDs :many
SELECT user_id FROM dm_participants WHERE channel_id = ?;

-- name: GetUserDMChannelIDs :many
SELECT channel_id FROM dm_open_state WHERE user_id = ?;

-- name: GetUserDMChannels :many
SELECT
    c.id                                          AS channel_id,
    u.id                                          AS recipient_id,
    u.username                                    AS recipient_username,
    COALESCE(u.avatar, '')                        AS recipient_avatar,
    u.status                                      AS recipient_status,
    lm.id                                         AS last_message_id,
    COALESCE(lm.content, '')                      AS last_message,
    COALESCE(lm.timestamp, '')                    AS last_message_at,
    (SELECT COUNT(*) FROM messages mu
      WHERE mu.channel_id = c.id AND mu.deleted = 0
        AND mu.id > COALESCE((SELECT rs.last_message_id FROM read_states rs
                               WHERE rs.channel_id = c.id AND rs.user_id = dos.user_id), 0)
    ) AS unread_count
FROM dm_open_state dos
JOIN channels c          ON c.id = dos.channel_id AND c.type = 'dm'
JOIN dm_participants dp  ON dp.channel_id = c.id AND dp.user_id != ?
JOIN users u             ON u.id = dp.user_id
LEFT JOIN messages lm    ON lm.id = (
    SELECT MAX(id) FROM messages WHERE channel_id = c.id AND deleted = 0
)
WHERE dos.user_id = ?
ORDER BY COALESCE(lm.timestamp, dos.opened_at) DESC;
