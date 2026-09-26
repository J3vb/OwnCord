-- Second-factor state (migration 032, B4-3). ASCII only in this file: sqlc
-- v1.30.0 miscounts multi-byte characters and truncates the next query.

-- name: UpsertPartialAuthChallenge :exec
INSERT INTO partial_auth_challenges (token_hash, user_id, device, ip_address, failures, expires_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(token_hash) DO UPDATE SET
    user_id    = excluded.user_id,
    device     = excluded.device,
    ip_address = excluded.ip_address,
    failures   = excluded.failures,
    expires_at = excluded.expires_at;

-- name: GetPartialAuthChallenge :one
SELECT user_id, device, ip_address, failures, expires_at
FROM partial_auth_challenges
WHERE token_hash = ?;

-- name: DeletePartialAuthChallenge :execresult
DELETE FROM partial_auth_challenges WHERE token_hash = ?;

-- name: CleanupExpiredPartialAuthChallenges :exec
DELETE FROM partial_auth_challenges WHERE expires_at <= ?;

-- name: UpsertPendingTOTPEnrollment :exec
INSERT INTO pending_totp_enrollments (user_id, secret_enc, expires_at)
VALUES (?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET
    secret_enc = excluded.secret_enc,
    expires_at = excluded.expires_at;

-- name: GetPendingTOTPEnrollment :one
SELECT secret_enc, expires_at
FROM pending_totp_enrollments
WHERE user_id = ?;

-- name: DeletePendingTOTPEnrollment :exec
DELETE FROM pending_totp_enrollments WHERE user_id = ?;

-- name: CleanupExpiredPendingTOTPEnrollments :exec
DELETE FROM pending_totp_enrollments WHERE expires_at <= ?;

-- name: InsertUsedTOTPCode :execresult
INSERT OR IGNORE INTO totp_used_codes (user_id, code_hash, expires_at)
VALUES (?, ?, ?);

-- name: DeleteUsedTOTPCode :exec
DELETE FROM totp_used_codes WHERE user_id = ? AND code_hash = ?;

-- name: CleanupExpiredUsedTOTPCodes :exec
DELETE FROM totp_used_codes WHERE expires_at <= ?;

-- name: InsertRecoveryCode :exec
INSERT INTO totp_recovery_codes (user_id, code_hash, created_at)
VALUES (?, ?, ?);

-- name: ListUnusedRecoveryCodes :many
SELECT id, code_hash
FROM totp_recovery_codes
WHERE user_id = ? AND used_at IS NULL
ORDER BY id ASC;

-- name: MarkRecoveryCodeUsed :execresult
UPDATE totp_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL;

-- name: CountUnusedRecoveryCodes :one
SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL;

-- name: DeleteRecoveryCodes :exec
DELETE FROM totp_recovery_codes WHERE user_id = ?;
