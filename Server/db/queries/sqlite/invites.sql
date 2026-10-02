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
SELECT i.id, i.code, i.created_by, COALESCE(u.username, '') AS creator_username,
       i.max_uses, i.use_count, i.expires_at, i.revoked, i.created_at
FROM invites i LEFT JOIN users u ON u.id = i.created_by
ORDER BY i.created_at DESC LIMIT 200;

-- name: CreateInviteRedemption :exec
INSERT INTO invite_redemptions (invite_id, user_id)
SELECT id, sqlc.arg(user_id) FROM invites WHERE code = sqlc.arg(code);

-- name: ListInviteRedemptions :many
-- user_id is nullable: an erased redeemer leaves the row with no link.
SELECT r.id, r.user_id, COALESCE(u.username, '') AS username, r.redeemed_at
FROM invite_redemptions r
LEFT JOIN users u ON u.id = r.user_id
WHERE r.invite_id = ?
ORDER BY r.redeemed_at DESC, r.id DESC
LIMIT ?;
