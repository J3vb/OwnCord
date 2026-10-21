-- Per-user, per-channel NSFW acknowledgement (migration 047, B5-7). See the
-- migration's own comment for the shape and Server/permissions/predicates.go
-- (CanReadContent) for the gate these back.
--
-- The reads and the revoke resolve a channel id through its parent first
-- (migration 073): a thread takes its parent's NSFW label, so it takes the
-- parent's consent too. No row is keyed by a thread id: the acknowledge in
-- db/nsfw_queries.go checks the row's own label, which is 0 on a thread.

-- name: AcknowledgeNSFW :exec
INSERT OR IGNORE INTO nsfw_acknowledgements (user_id, channel_id) VALUES (?, ?);

-- name: RevokeNSFW :exec
DELETE FROM nsfw_acknowledgements WHERE user_id = sqlc.arg(user_id) AND channel_id = (
    SELECT COALESCE(ac.parent_channel_id, ac.id) FROM channels ac WHERE ac.id = sqlc.arg(channel_id));

-- name: HasNSFWAcknowledgement :one
SELECT COUNT(*) FROM nsfw_acknowledgements WHERE user_id = sqlc.arg(user_id) AND channel_id = (
    SELECT COALESCE(ac.parent_channel_id, ac.id) FROM channels ac WHERE ac.id = sqlc.arg(channel_id));

-- name: ListNSFWAcknowledgedUserIDs :many
SELECT user_id FROM nsfw_acknowledgements WHERE channel_id = (
    SELECT COALESCE(ac.parent_channel_id, ac.id) FROM channels ac WHERE ac.id = sqlc.arg(channel_id));

-- name: DeleteNSFWAcknowledgementsForChannel :exec
DELETE FROM nsfw_acknowledgements WHERE channel_id = ?;
