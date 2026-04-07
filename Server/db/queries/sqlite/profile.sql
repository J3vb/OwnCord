-- name: UpdateUserProfile :execresult
UPDATE users SET username = ?, avatar = ? WHERE id = ?;

-- name: UpdateUserPassword :exec
UPDATE users SET password = ? WHERE id = ?;
