-- name: GetUserByUsername :one
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires, identity_public_key,
       display_name, about, custom_status
FROM users WHERE username = ? COLLATE NOCASE;

-- name: GetUserByID :one
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires, identity_public_key,
       display_name, about, custom_status
FROM users WHERE id = ?;

-- name: CreateUser :execresult
INSERT INTO users (username, password, role_id) VALUES (?, ?, ?);

-- name: UpdateUserStatus :exec
UPDATE users SET status = ?, last_seen = datetime('now') WHERE id = ?;

-- name: UpdateUserTOTPSecret :exec
UPDATE users SET totp_secret = ? WHERE id = ?;

-- name: UpdateUserIdentityKey :exec
UPDATE users SET identity_public_key = ? WHERE id = ?;

-- name: MarkUserDisconnected :exec
-- Disconnect bookkeeping. It clears only 'online', which is the one status
-- that means "has a live session"; idle, dnd and invisible are choices the
-- user made and are what the next connect reads instead of stamping online
-- (db.ConnectStatus). A stale choice never renders as "present" because the
-- read path treats a member with no live connection as offline regardless.
UPDATE users
SET status = CASE WHEN status = 'online' THEN 'offline' ELSE status END,
    last_seen = datetime('now')
WHERE id = ?;

-- name: ResetAllUserStatuses :exec
-- Startup reset: nothing is connected yet, so every 'online' is a leftover
-- from the previous process. Chosen statuses survive for the same reason they
-- survive a disconnect.
UPDATE users SET status = 'offline' WHERE status = 'online';

-- name: BanUser :exec
UPDATE users SET banned = 1, ban_reason = ?, ban_expires = ? WHERE id = ?;

-- name: UnbanUser :exec
UPDATE users SET banned = 0, ban_reason = NULL, ban_expires = NULL WHERE id = ?;

-- name: ListMembers :many
SELECT u.id, u.username, u.avatar, u.status, LOWER(r.name), u.identity_public_key,
       u.display_name, u.custom_status
FROM users u
JOIN roles r ON u.role_id = r.id
WHERE u.banned = 0
ORDER BY u.username ASC
LIMIT 1000;

-- name: CountUsers :one
SELECT COUNT(*) FROM users;

-- name: CountUsersWithoutTOTP :one
SELECT COUNT(*) FROM users WHERE banned = 0 AND totp_secret IS NULL;
