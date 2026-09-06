-- Per-user, per-channel NSFW acknowledgement (migration 047, B5-7). See the
-- migration's own comment for the shape and Server/permissions/predicates.go
-- (CanReadContent) for the gate these back.

-- name: AcknowledgeNSFW :exec
INSERT OR IGNORE INTO nsfw_acknowledgements (user_id, channel_id) VALUES (?, ?);

-- name: RevokeNSFW :exec
DELETE FROM nsfw_acknowledgements WHERE user_id = ? AND channel_id = ?;

-- name: HasNSFWAcknowledgement :one
SELECT COUNT(*) FROM nsfw_acknowledgements WHERE user_id = ? AND channel_id = ?;

-- name: ListNSFWAcknowledgedUserIDs :many
SELECT user_id FROM nsfw_acknowledgements WHERE channel_id = ?;

-- name: DeleteNSFWAcknowledgementsForChannel :exec
DELETE FROM nsfw_acknowledgements WHERE channel_id = ?;
