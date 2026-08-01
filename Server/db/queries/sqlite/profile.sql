-- name: UpdateUserProfile :execresult
UPDATE users
SET username = ?, avatar = ?, display_name = ?, about = ?
WHERE id = ?;

-- name: UpdateUserPassword :exec
UPDATE users SET password = ? WHERE id = ?;

-- name: UpdateUserCustomStatus :exec
-- Separate from UpdateUserProfile because a custom status arrives over the
-- WebSocket presence path, not the REST profile PATCH, and must not be able to
-- clobber the username/avatar of a profile edit racing it.
UPDATE users SET custom_status = ? WHERE id = ?;

-- name: CountUsersWithAvatar :one
-- Authorization probe for the file route: an unlinked attachment is readable by
-- everyone exactly while some user's avatar points at it. Covered by the
-- partial index on users(avatar) added in migration 027.
SELECT COUNT(*) FROM users WHERE avatar = ?;
