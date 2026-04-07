-- PostgreSQL variants of the sqlite profile queries.
-- UpdateUserProfile uses :execrows because postgres has no LastInsertId;
-- the caller checks rows-affected for existence.

-- name: UpdateUserProfile :execrows
UPDATE users SET username = $1, avatar = $2 WHERE id = $3;

-- name: UpdateUserPassword :exec
UPDATE users SET password = $1 WHERE id = $2;
