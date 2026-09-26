-- Message requests and trusted senders (migration 046, B5-6). See the
-- migration's own comment for the shape and the service layer
-- (service/message_request.go) for the gate these back.

-- name: IsTrustedSender :one
SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?;

-- name: TrustSender :exec
INSERT OR IGNORE INTO trusted_senders (recipient_id, sender_id, source) VALUES (?, ?, ?);

-- name: InsertMessageRequest :execrows
INSERT OR IGNORE INTO message_requests (sender_id, recipient_id, channel_id, first_message_id) VALUES (?, ?, ?, ?);

-- name: GetMessageRequestForRecipient :one
SELECT id, sender_id, recipient_id, channel_id, first_message_id, state, created_at, decided_at
FROM message_requests
WHERE id = ? AND recipient_id = ?;

-- name: GetMessageRequestByPair :one
SELECT id, sender_id, recipient_id, channel_id, first_message_id, state, created_at, decided_at
FROM message_requests
WHERE sender_id = ? AND recipient_id = ?;

-- name: ListPendingMessageRequests :many
SELECT
    mr.id                         AS id,
    mr.sender_id                  AS sender_id,
    mr.recipient_id               AS recipient_id,
    mr.channel_id                 AS channel_id,
    mr.state                      AS state,
    mr.created_at                 AS created_at,
    mr.decided_at                 AS decided_at,
    u.username                    AS sender_username,
    COALESCE(u.display_name, '')  AS sender_display_name,
    COALESCE(u.avatar, '')        AS sender_avatar,
    COALESCE(pm.id, 0)            AS preview_message_id,
    COALESCE(pm.content, '')      AS preview_content,
    COALESCE(pm.timestamp, '')    AS preview_timestamp
FROM message_requests mr
JOIN users u ON u.id = mr.sender_id
LEFT JOIN messages pm ON pm.id = mr.first_message_id AND pm.deleted = 0
WHERE mr.recipient_id = ? AND mr.state = 'pending'
ORDER BY mr.id DESC;

-- name: TransitionMessageRequest :execrows
UPDATE message_requests
SET state = ?, decided_at = datetime('now')
WHERE id = ? AND recipient_id = ? AND state = 'pending';
