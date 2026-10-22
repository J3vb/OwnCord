-- name: UpdateUserProfile :execresult
UPDATE users
SET username = ?, avatar = ?, display_name = ?, about = ?,
    banner_id = ?, banner_color = ?
WHERE id = ?;

-- name: UpdateUserPassword :exec
UPDATE users SET password = ? WHERE id = ?;

-- name: UpdateUserCustomStatus :exec
-- Separate from UpdateUserProfile because a custom status arrives over the
-- WebSocket presence path, not the REST profile PATCH, and must not be able to
-- clobber the username/avatar of a profile edit racing it.
-- The expiry rides with the text: a new text without an expiry replaces any old
-- one, and a NULL text (logout, clear) clears both.
UPDATE users SET custom_status = ?, custom_status_expires_at = ? WHERE id = ?;

-- name: NextCustomStatusExpiry :one
-- The soonest pending expiry; no row when none is pending. Served by the
-- partial index on custom_status_expires_at.
SELECT custom_status_expires_at FROM users
WHERE custom_status_expires_at IS NOT NULL
ORDER BY custom_status_expires_at
LIMIT 1;

-- name: ListExpiredCustomStatuses :many
-- Rows whose expiry has passed, oldest first. The expirer clears each with
-- ClearCustomStatusIfExpiry so a status set after this read is never undone.
SELECT id, custom_status_expires_at FROM users
WHERE custom_status_expires_at IS NOT NULL AND custom_status_expires_at <= ?
ORDER BY custom_status_expires_at, id
LIMIT ?;

-- name: ClearCustomStatusIfExpiry :execrows
-- Compare-and-clear: only clears while the stored expiry still equals the one
-- the caller read, so a status set in the same instant survives.
UPDATE users SET custom_status = NULL, custom_status_expires_at = NULL
WHERE id = ? AND custom_status_expires_at = ?;

-- name: CountUsersWithAvatar :one
-- Authorization probe for the file route: an unlinked attachment is readable by
-- everyone exactly while some user's avatar points at it. Covered by the
-- partial index on users(avatar) added in migration 027.
SELECT COUNT(*) FROM users WHERE avatar = ?;

-- name: IsBannerFile :one
-- Authorization probe for the file route: an unlinked attachment is readable by
-- everyone exactly while some user's banner_id names it. Served by the partial
-- index idx_users_banner_id (migration 069).
SELECT EXISTS (SELECT 1 FROM users WHERE banner_id = ?) AS is_banner;
