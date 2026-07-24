-- name: CreateAPIToken :execresult
INSERT INTO api_tokens (user_id, token_hash, label, expires_at)
VALUES (?, ?, ?, ?);

-- name: GetActiveAPIToken :one
-- Auth-hot lookup: returns the token only if it is neither revoked nor expired,
-- so a resolved row is always usable. Matches the sessions never-expiring
-- convention (expires_at IS NULL).
SELECT id, user_id, token_hash, label, created_at, last_used_at, expires_at, revoked_at
FROM api_tokens
WHERE token_hash = ?
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'));

-- name: ListAPITokens :many
-- Admin/CLI listing. Never selects token_hash (unrecoverable; only the raw
-- token shown at creation is usable).
SELECT t.id, t.user_id, COALESCE(u.username, '') AS username, t.label,
       t.created_at, t.last_used_at, t.expires_at, t.revoked_at
FROM api_tokens t
LEFT JOIN users u ON u.id = t.user_id
ORDER BY t.id DESC
LIMIT 200;

-- name: RevokeAPIToken :execresult
UPDATE api_tokens SET revoked_at = datetime('now')
WHERE id = ? AND revoked_at IS NULL;

-- name: RevokeAPITokenByLabel :execresult
UPDATE api_tokens SET revoked_at = datetime('now')
WHERE label = ? AND revoked_at IS NULL;

-- name: TouchAPIToken :exec
UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?;

-- name: GetOwnerUser :one
-- The highest-privilege account (role with the greatest position), used as the
-- default identity for `token create`. FROM is users-only (role position is a
-- correlated subquery, not a join) so the row maps through userFromGen exactly
-- like GetUserByID, so keep this SELECT list identical to GetUserByID's.
-- A :one query already reads a single row via QueryRow, so no LIMIT is needed
-- (and an explicit LIMIT 1 is mis-emitted by sqlc here). ORDER BY puts the
-- highest-position role first, so that first row is the owner.
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires, identity_public_key
FROM users
ORDER BY (SELECT r.position FROM roles r WHERE r.id = users.role_id) DESC, id ASC;
