-- name: CreateInvite :exec
INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?);

-- name: GetInvite :one
SELECT id, code, created_by, max_uses, use_count, expires_at, revoked, created_at
FROM invites WHERE code = ?;

-- name: UseInviteAtomic :execresult
UPDATE invites SET use_count = use_count + 1
WHERE code = ? AND revoked = 0
  AND (max_uses IS NULL OR use_count < max_uses)
  AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'));

-- name: RevokeInvite :exec
UPDATE invites SET revoked = 1 WHERE code = ?;

-- name: ListInvites :many
SELECT id, code, created_by, max_uses, use_count, expires_at, revoked, created_at
FROM invites ORDER BY created_at DESC LIMIT 200;
