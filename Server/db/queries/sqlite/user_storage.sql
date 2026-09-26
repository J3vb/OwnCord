-- user_storage is the per-user upload byte counter (migration 044, B5-2).
-- Keep this file ASCII-only: sqlc v1.30 truncates the next query by the
-- byte/rune difference of any multi-byte character.

-- name: EnsureUserStorage :exec
INSERT OR IGNORE INTO user_storage (user_id, bytes_used) VALUES (?, 0);

-- name: ChargeUserStorage :execrows
-- The quota guard and the increment are one statement, so exactly one of
-- N concurrent uploads racing the last byte is admitted: SQLite serialises
-- writers and the WHERE is evaluated against the row the UPDATE sees.
-- Rows affected = admitted.
UPDATE user_storage
   SET bytes_used = bytes_used + sqlc.arg(bytes)
 WHERE user_id = sqlc.arg(user_id)
   AND bytes_used + sqlc.arg(bytes) <= sqlc.arg(quota);

-- name: ChargeUserStorageUnbounded :exec
-- The unlimited-quota form: the counter is maintained whether or not a
-- quota is set, so turning one on later starts from a live number.
UPDATE user_storage SET bytes_used = bytes_used + ? WHERE user_id = ?;

-- name: ReleaseUserStorage :exec
-- MAX(0, ...) rather than a bare subtraction: a recount may already have
-- lowered the row below the charge being released, and the CHECK
-- constraint would otherwise turn the release into an error.
UPDATE user_storage SET bytes_used = MAX(0, bytes_used - sqlc.arg(bytes)) WHERE user_id = sqlc.arg(user_id);

-- name: GetUserStorage :one
SELECT bytes_used FROM user_storage WHERE user_id = ?;

-- name: ListUserStorageIDs :many
SELECT user_id FROM user_storage ORDER BY user_id;

-- name: RecountUserStorage :exec
-- The truth: every counted byte this user holds in the store has an
-- attachments row that names it (avatars are attachments). Emoji are a
-- bounded exclusion, see migration 044.
UPDATE user_storage
   SET bytes_used = (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE uploader_id = user_storage.user_id)
 WHERE user_id = ?;

-- name: TotalAttachmentBytes :one
-- The operator's storage figure on the metrics surface: every attachments
-- row, legacy rows with a NULL uploader_id included, so it is a total and
-- not a sum of counters.
SELECT CAST(COALESCE(SUM(size), 0) AS INTEGER) AS total FROM attachments;

