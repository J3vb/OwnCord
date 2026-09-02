-- name: GetUserByUsername :one
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires, identity_public_key,
       display_name, about, custom_status, registration_status
FROM users WHERE username = ? COLLATE NOCASE;

-- name: GetUserByID :one
SELECT id, username, password, avatar, role_id, totp_secret, status,
       created_at, last_seen, banned, ban_reason, ban_expires, identity_public_key,
       display_name, about, custom_status, registration_status
FROM users WHERE id = ?;

-- name: CreateUser :execresult
INSERT INTO users (username, password, role_id) VALUES (?, ?, ?);

-- Approval-mode registration (B4-1): the account exists from the application
-- on, as registration_status = 'pending', and cannot sign in until an admin
-- approves it. Denial anonymises the row and marks it 'denied' for good.
-- name: CreatePendingUser :execresult
INSERT INTO users (username, password, role_id, registration_status) VALUES (?, ?, ?, 'pending');

-- name: ListPendingUsers :many
SELECT id, username, created_at FROM users
WHERE registration_status = 'pending'
ORDER BY created_at ASC, id ASC
LIMIT ? OFFSET ?;

-- name: CountPendingUsers :one
SELECT COUNT(*) FROM users WHERE registration_status = 'pending';

-- name: ApprovePendingUser :execresult
UPDATE users SET registration_status = 'active' WHERE id = ? AND registration_status = 'pending';

-- name: DenyPendingUser :execresult
UPDATE users
SET registration_status = 'denied',
    username = '[denied-' || id || ']',
    password = '',
    avatar = NULL,
    display_name = NULL,
    about = NULL,
    custom_status = NULL,
    status = 'offline'
WHERE id = ? AND registration_status = 'pending';

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

-- The ready payload's member roster. docs/protocol.md documents members[] as
-- "All registered users", so this must not silently truncate: the previous
-- LIMIT 1000 dropped every member past the first thousand with no has_more
-- signal, leaving those users unrenderable and unmentionable on the client
-- with nothing to indicate the list was incomplete.
-- name: ListMembers :many
SELECT u.id, u.username, u.avatar, u.status, LOWER(r.name), u.identity_public_key,
       u.display_name, u.custom_status
FROM users u
JOIN roles r ON u.role_id = r.id
WHERE (u.banned = 0 OR (u.ban_expires IS NOT NULL AND replace(u.ban_expires, ' ', 'T') <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
  AND u.registration_status = 'active'
ORDER BY u.username ASC;

-- name: CountUsers :one
SELECT COUNT(*) FROM users;

-- A lapsed temporary ban must not hide a TOTP-less user from this count: the
-- ban_expires arm mirrors auth.IsEffectivelyBanned (and db.notBannedClause /
-- ListMembers above), which treats an elapsed ban as "not banned" and lets
-- the user log in. Without it, require_2fa can be enabled while such a user
-- still exists, and their next login is refused forever with no recovery
-- path. The replace() normalises the space-separator form of ban_expires to
-- 'T' before comparing, because ' ' sorts below 'T'.
-- name: CountUsersWithoutTOTP :one
SELECT COUNT(*) FROM users
WHERE (banned = 0
       OR (ban_expires IS NOT NULL
           AND replace(ban_expires, ' ', 'T') <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
  AND totp_secret IS NULL
  AND registration_status = 'active';
