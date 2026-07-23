-- name: GetUserByUsername :one
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires, identity_public_key
FROM users WHERE username = ? COLLATE NOCASE;

-- name: GetUserByID :one
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires, identity_public_key
FROM users WHERE id = ?;

-- name: CreateUser :execresult
INSERT INTO users (username, password, role_id) VALUES (?, ?, ?);

-- name: UpdateUserStatus :exec
UPDATE users SET status = ?, last_seen = datetime('now') WHERE id = ?;

-- name: UpdateUserTOTPSecret :exec
UPDATE users SET totp_secret = ? WHERE id = ?;

-- name: UpdateUserIdentityKey :exec
UPDATE users SET identity_public_key = ? WHERE id = ?;

-- name: ResetAllUserStatuses :exec
UPDATE users SET status = 'offline' WHERE status != 'offline';

-- name: BanUser :exec
UPDATE users SET banned = 1, ban_reason = ?, ban_expires = ? WHERE id = ?;

-- name: UnbanUser :exec
UPDATE users SET banned = 0, ban_reason = NULL, ban_expires = NULL WHERE id = ?;

-- name: ListMembers :many
SELECT u.id, u.username, u.avatar, u.status, LOWER(r.name), u.identity_public_key
FROM users u
JOIN roles r ON u.role_id = r.id
WHERE u.banned = 0
ORDER BY u.username ASC
LIMIT 1000;

-- name: CountUsers :one
SELECT COUNT(*) FROM users;

-- name: CountUsersWithoutTOTP :one
SELECT COUNT(*) FROM users WHERE banned = 0 AND totp_secret IS NULL;
