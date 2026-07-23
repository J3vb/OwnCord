-- name: OpenDM :exec
INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?);

-- name: CloseDM :exec
DELETE FROM dm_open_state WHERE user_id = ? AND channel_id = ?;

-- name: IsDMParticipant :one
SELECT user_id FROM dm_participants WHERE user_id = ? AND channel_id = ?;

-- name: GetDMParticipantIDs :many
SELECT user_id FROM dm_participants WHERE channel_id = ?;

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
    COUNT(CASE WHEN m_unread.id > COALESCE(rs.last_message_id, 0)
               AND m_unread.deleted = 0 THEN 1 END) AS unread_count
FROM dm_open_state dos
JOIN channels c          ON c.id = dos.channel_id AND c.type = 'dm'
JOIN dm_participants dp  ON dp.channel_id = c.id AND dp.user_id != ?
JOIN users u             ON u.id = dp.user_id
LEFT JOIN messages lm    ON lm.id = (
    SELECT MAX(id) FROM messages WHERE channel_id = c.id AND deleted = 0
)
LEFT JOIN messages m_unread ON m_unread.channel_id = c.id
LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
WHERE dos.user_id = ?
GROUP BY c.id
ORDER BY COALESCE(lm.timestamp, dos.opened_at) DESC;
