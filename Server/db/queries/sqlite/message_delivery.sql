-- name: GetMessageDeliveryReceipt :one
SELECT r.user_id, r.client_message_id, r.channel_id, r.payload_hash,
       r.message_id, r.timestamp, r.expires_at_ms,
       EXISTS(SELECT 1 FROM messages m WHERE m.id = r.message_id
              AND m.user_id = r.user_id AND m.channel_id = r.channel_id AND m.deleted = 0) AS available
FROM message_delivery_receipts r WHERE r.user_id = ? AND r.client_message_id = ?;

-- name: InsertMessageDeliveryReceipt :exec
INSERT INTO message_delivery_receipts
    (user_id, client_message_id, channel_id, payload_hash, message_id, timestamp, expires_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: DeleteExpiredMessageDeliveryReceipts :exec
DELETE FROM message_delivery_receipts WHERE expires_at_ms <= ?;

-- name: CreateMessageForDelivery :one
INSERT INTO messages (channel_id, user_id, content, reply_to, mentions_everyone)
VALUES (?, ?, ?, ?, ?)
RETURNING id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp, mentions_everyone;
