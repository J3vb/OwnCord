-- Owner-issued recovery credentials (B4-6): one per account, replaced on
-- issuance, deleted by the redemption that consumes it. The verifier is an
-- argon2id PHC string and no query returns anything else about the secret.

-- name: UpsertRecoveryAssist :exec
INSERT INTO recovery_assists (user_id, verifier, issued_by, verification, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET verifier = excluded.verifier,
                                   issued_by = excluded.issued_by,
                                   verification = excluded.verification,
                                   created_at = excluded.created_at,
                                   expires_at = excluded.expires_at;

-- name: GetRecoveryAssist :one
SELECT user_id, verifier, issued_by, verification, created_at, expires_at
FROM recovery_assists WHERE user_id = ?;

-- The consume deletes only the live credential whose verifier the caller
-- compared against, so the affected row count is what tells two concurrent
-- redemptions, an expired credential, and a credential replaced since the
-- compare apart.
-- name: ConsumeRecoveryAssist :execresult
DELETE FROM recovery_assists WHERE user_id = ? AND verifier = ? AND expires_at > ?;

-- name: DeleteRecoveryAssist :exec
DELETE FROM recovery_assists WHERE user_id = ?;
