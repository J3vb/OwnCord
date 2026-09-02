-- Recovery kits (B4-5): one verifier per account, replaced on enrolment,
-- spent by a successful recovery. The verifier is an argon2id PHC string;
-- no query ever returns anything else about the kit.

-- name: UpsertRecoveryKit :exec
INSERT INTO recovery_kits (user_id, verifier, created_at, used_at)
VALUES (?, ?, ?, NULL)
ON CONFLICT(user_id) DO UPDATE SET verifier = excluded.verifier,
                                   created_at = excluded.created_at,
                                   used_at = NULL;

-- name: GetRecoveryKit :one
SELECT user_id, verifier, created_at, used_at FROM recovery_kits WHERE user_id = ?;

-- The consume is conditional: only an unspent kit is spent, and the affected
-- row count is what tells two concurrent redemptions apart.
-- name: ConsumeRecoveryKit :execresult
UPDATE recovery_kits SET used_at = ? WHERE user_id = ? AND used_at IS NULL;

-- name: DeleteRecoveryKit :exec
DELETE FROM recovery_kits WHERE user_id = ?;
