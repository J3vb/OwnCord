-- PostgreSQL variants of the sqlite invites queries.
-- The expiry check uses native timestamp comparison instead of sqlite's
-- strftime('%s', …) trick.

-- name: CreateInvite :exec
INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES ($1, $2, $3, $4);

-- name: GetInvite :one
SELECT id, code, created_by, max_uses, use_count, expires_at, revoked, created_at
FROM invites WHERE code = $1;

-- name: UseInviteAtomic :execrows
UPDATE invites SET use_count = use_count + 1
WHERE code = $1 AND revoked = FALSE
  AND (max_uses IS NULL OR use_count < max_uses)
  AND (expires_at IS NULL OR expires_at > NOW());

-- name: RevokeInvite :exec
UPDATE invites SET revoked = TRUE WHERE code = $1;

-- name: ListInvites :many
SELECT id, code, created_by, max_uses, use_count, expires_at, revoked, created_at
FROM invites ORDER BY created_at DESC LIMIT 200;
