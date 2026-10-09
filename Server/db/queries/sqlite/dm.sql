-- name: OpenDM :execrows
INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?);

-- name: CloseDM :exec
DELETE FROM dm_open_state WHERE user_id = ? AND channel_id = ?;

-- name: IsDMParticipant :one
SELECT user_id FROM dm_participants WHERE user_id = ? AND channel_id = ?;

-- name: GetDMParticipantIDs :many
SELECT user_id FROM dm_participants WHERE channel_id = ?;

-- name: CountDMParticipants :one
SELECT COUNT(*) FROM dm_participants WHERE channel_id = ?;

-- name: GetDMDeliveryTargets :many
-- One read for a DM send's whole fan-out decision: every participant, the
-- channel's group flag, whether the participant's DM row is already open, and
-- whether the participant trusts sender_id (message requests).
SELECT
    dp.user_id AS user_id,
    c.is_group AS is_group,
    CAST(EXISTS (
        SELECT 1 FROM dm_open_state o
        WHERE o.user_id = dp.user_id AND o.channel_id = dp.channel_id
    ) AS INTEGER) AS is_open,
    CAST(EXISTS (
        SELECT 1 FROM trusted_senders t
        WHERE t.recipient_id = dp.user_id AND t.sender_id = sqlc.arg(sender_id)
    ) AS INTEGER) AS trusts_sender
FROM dm_participants dp
JOIN channels c ON c.id = dp.channel_id AND c.type = 'dm'
WHERE dp.channel_id = sqlc.arg(channel_id);

-- name: IsGroupDM :one
SELECT is_group FROM channels WHERE id = ? AND type = 'dm';

-- name: SetDMChannelName :exec
UPDATE channels SET name = ? WHERE id = ? AND type = 'dm';

-- name: GetDMParticipants :many
SELECT
    u.id                                      AS id,
    u.username                                AS username,
    COALESCE(u.display_name, '')              AS display_name,
    COALESCE(u.avatar, '')                    AS avatar,
    u.status                                  AS status
FROM dm_participants dp
JOIN users u ON u.id = dp.user_id
WHERE dp.channel_id = ?
ORDER BY u.id ASC;

-- name: GetUserDMChannelIDs :many
SELECT channel_id FROM dm_open_state WHERE user_id = ?;

-- A DM row carries no recipient any more: dm_participants holds N users, so
-- "the other one" is only well defined for a two-person DM. The participant
-- set comes from GetDMParticipantsForUser below, one extra query for the whole
-- list rather than one per channel, and the Go layer stitches them together.
-- name: GetUserDMChannels :many
SELECT
    c.id                                          AS channel_id,
    c.name                                        AS name,
    c.is_group                                    AS is_group,
    lm.id                                         AS last_message_id,
    COALESCE(lm.content, '')                      AS last_message,
    COALESCE(lm.timestamp, '')                    AS last_message_at,
    (SELECT COUNT(*) FROM (SELECT 1 FROM messages mu
      WHERE mu.channel_id = c.id AND mu.deleted = 0
        AND mu.id > COALESCE((SELECT rs.last_message_id FROM read_states rs
                               WHERE rs.channel_id = c.id AND rs.user_id = dos.user_id), 0)
      LIMIT 100)
    ) AS unread_count,
    CAST(COALESCE((SELECT rs.mention_count FROM read_states rs
               WHERE rs.channel_id = c.id AND rs.user_id = dos.user_id), 0) AS INTEGER) AS mention_count
FROM dm_open_state dos
JOIN channels c          ON c.id = dos.channel_id AND c.type = 'dm'
LEFT JOIN messages lm    ON lm.id = (
    SELECT MAX(id) FROM messages WHERE channel_id = c.id AND deleted = 0
)
WHERE dos.user_id = ?
ORDER BY COALESCE(lm.timestamp, dos.opened_at) DESC;

-- Every participant of every DM the user has open, in one pass. Includes the
-- user themselves so a caller can tell "group of three" from "group of three
-- others"; the Go layer filters when it needs the others.
-- name: GetDMParticipantsForUser :many
SELECT
    dp.channel_id                                 AS channel_id,
    u.id                                          AS id,
    u.username                                    AS username,
    COALESCE(u.display_name, '')                  AS display_name,
    COALESCE(u.avatar, '')                        AS avatar,
    u.status                                      AS status
FROM dm_open_state dos
JOIN dm_participants dp ON dp.channel_id = dos.channel_id
JOIN users u            ON u.id = dp.user_id
WHERE dos.user_id = ?
ORDER BY dp.channel_id ASC, u.id ASC;

-- The 1:1 DM channel between two users, if one exists. Mirrors the lookup
-- inside GetOrCreateDMChannel (raw, transactional) without creating anything:
-- the is_group clause keeps group DMs out, matching the block-enforcement
-- boundary (blocks never gate group DMs). ORDER BY makes the row choice
-- deterministic should duplicates ever exist.
-- name: FindDMChannelIDBetween :one
SELECT dp1.channel_id FROM dm_participants dp1
JOIN dm_participants dp2 ON dp1.channel_id = dp2.channel_id
JOIN channels c ON c.id = dp1.channel_id
WHERE dp1.user_id = ? AND dp2.user_id = ? AND c.type = 'dm' AND c.is_group = 0
ORDER BY dp1.channel_id ASC;

-- Reopen only for a current participant, in the one statement, so a member who
-- leaves between a membership check and this write cannot get the DM back.
-- name: OpenDMIfParticipant :execrows
INSERT OR IGNORE INTO dm_open_state (user_id, channel_id)
SELECT ?1, ?2
WHERE EXISTS (SELECT 1 FROM dm_participants WHERE user_id = ?1 AND channel_id = ?2);
