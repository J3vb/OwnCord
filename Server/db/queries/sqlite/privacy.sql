-- user_privacy holds one direct message privacy row per user (migration 070, WP 6.8b).
-- A missing row means both settings are on. Keep this file ASCII-only: sqlc
-- v1.30 truncates the next query by the byte/rune difference of any multi-byte
-- character.

-- name: GetUserPrivacy :one
SELECT allow_member_dms, message_requests FROM user_privacy WHERE user_id = sqlc.arg(user_id);

-- name: UpsertUserPrivacy :exec
-- One statement replaces the whole row, so two concurrent writers leave one
-- complete body and never a mix of the two.
INSERT INTO user_privacy (user_id, allow_member_dms, message_requests)
VALUES (sqlc.arg(user_id), sqlc.arg(allow_member_dms), sqlc.arg(message_requests))
ON CONFLICT (user_id) DO UPDATE
   SET allow_member_dms = excluded.allow_member_dms,
       message_requests = excluded.message_requests,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');

-- name: DMRefusesSender :one
-- 1 when the recipient has turned direct messages from members off and has no
-- trust row for the sender, else 0. A missing user_privacy row is "on". The
-- trust check is an anti-join because sqlc does not bind parameters that sit
-- inside an EXISTS subquery.
SELECT CAST(COUNT(*) AS INTEGER) AS refuses
FROM user_privacy AS up
LEFT JOIN trusted_senders AS ts
  ON ts.recipient_id = up.user_id AND ts.sender_id = sqlc.arg(sender_id)
WHERE up.user_id = sqlc.arg(recipient_id)
  AND up.allow_member_dms = 0
  AND ts.recipient_id IS NULL;
