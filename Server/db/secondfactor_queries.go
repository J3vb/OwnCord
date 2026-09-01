package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Second-factor state (migration 032, B4-3): the durable backend behind the
// auth service's partial-auth, pending-enrolment and used-code stores
// (auth.SecondFactorPersister) and the emergency recovery-code rows. Nothing
// here sees a secret in the clear — callers hand over SHA-256 digests, AES-GCM
// ciphertext or bcrypt hashes. Timestamps are RFC3339 UTC text compared as
// text, the sessions/rate_lockouts convention.

func secondFactorTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

func parseSecondFactorTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing second-factor timestamp %q: %w", s, err)
	}
	return t, nil
}

// ── auth.SecondFactorPersister ────────────────────────────────────────────────

// UpsertPartialAuth writes or refreshes a login challenge keyed by the
// token's digest.
func (d *DB) UpsertPartialAuth(ctx context.Context, tokenHash string, userID int64, device, ip string, failures int, expiresAt time.Time) error {
	if err := d.q.UpsertPartialAuthChallenge(ctx, dbgen.UpsertPartialAuthChallengeParams{
		TokenHash: tokenHash,
		UserID:    userID,
		Device:    device,
		IpAddress: ip,
		Failures:  int64(failures),
		ExpiresAt: secondFactorTime(expiresAt),
	}); err != nil {
		return fmt.Errorf("UpsertPartialAuth: %w", err)
	}
	return nil
}

// GetPartialAuth reads a challenge; found is false for an unknown digest.
func (d *DB) GetPartialAuth(ctx context.Context, tokenHash string) (userID int64, device, ip string, failures int, expiresAt time.Time, found bool, err error) {
	row, err := d.q.GetPartialAuthChallenge(ctx, tokenHash)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", "", 0, time.Time{}, false, nil
	}
	if err != nil {
		return 0, "", "", 0, time.Time{}, false, fmt.Errorf("GetPartialAuth: %w", err)
	}
	exp, err := parseSecondFactorTime(row.ExpiresAt)
	if err != nil {
		return 0, "", "", 0, time.Time{}, false, fmt.Errorf("GetPartialAuth: %w", err)
	}
	return row.UserID, row.Device, row.IpAddress, int(row.Failures), exp, true, nil
}

// DeletePartialAuth removes a challenge and reports whether a row went —
// the single-winner decision behind PartialAuthStore.Consume.
func (d *DB) DeletePartialAuth(ctx context.Context, tokenHash string) (bool, error) {
	res, err := d.q.DeletePartialAuthChallenge(ctx, tokenHash)
	if err != nil {
		return false, fmt.Errorf("DeletePartialAuth: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("DeletePartialAuth: %w", err)
	}
	return n > 0, nil
}

// UpsertPendingTOTP stages an enrolment secret, already sealed by the caller.
func (d *DB) UpsertPendingTOTP(ctx context.Context, userID int64, encryptedSecret string, expiresAt time.Time) error {
	if err := d.q.UpsertPendingTOTPEnrollment(ctx, dbgen.UpsertPendingTOTPEnrollmentParams{
		UserID:    userID,
		SecretEnc: encryptedSecret,
		ExpiresAt: secondFactorTime(expiresAt),
	}); err != nil {
		return fmt.Errorf("UpsertPendingTOTP: %w", err)
	}
	return nil
}

// GetPendingTOTP reads a staged enrolment; found is false when none exists.
func (d *DB) GetPendingTOTP(ctx context.Context, userID int64) (encryptedSecret string, expiresAt time.Time, found bool, err error) {
	row, err := d.q.GetPendingTOTPEnrollment(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, fmt.Errorf("GetPendingTOTP: %w", err)
	}
	exp, err := parseSecondFactorTime(row.ExpiresAt)
	if err != nil {
		return "", time.Time{}, false, fmt.Errorf("GetPendingTOTP: %w", err)
	}
	return row.SecretEnc, exp, true, nil
}

// DeletePendingTOTP drops a staged enrolment.
func (d *DB) DeletePendingTOTP(ctx context.Context, userID int64) error {
	if err := d.q.DeletePendingTOTPEnrollment(ctx, userID); err != nil {
		return fmt.Errorf("DeletePendingTOTP: %w", err)
	}
	return nil
}

// InsertUsedTOTPCode records a code's use and reports whether the row was
// new; false means the code was already spent inside its window.
func (d *DB) InsertUsedTOTPCode(ctx context.Context, userID int64, codeHash string, expiresAt time.Time) (bool, error) {
	res, err := d.q.InsertUsedTOTPCode(ctx, dbgen.InsertUsedTOTPCodeParams{
		UserID:    userID,
		CodeHash:  codeHash,
		ExpiresAt: secondFactorTime(expiresAt),
	})
	if err != nil {
		return false, fmt.Errorf("InsertUsedTOTPCode: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("InsertUsedTOTPCode: %w", err)
	}
	return n > 0, nil
}

// DeleteUsedTOTPCode releases a recorded use (the Restore/Unmark path).
func (d *DB) DeleteUsedTOTPCode(ctx context.Context, userID int64, codeHash string) error {
	if err := d.q.DeleteUsedTOTPCode(ctx, dbgen.DeleteUsedTOTPCodeParams{UserID: userID, CodeHash: codeHash}); err != nil {
		return fmt.Errorf("DeleteUsedTOTPCode: %w", err)
	}
	return nil
}

// CleanupExpiredSecondFactorState removes challenges, staged enrolments and
// used-code rows past their expiry. Driven by the maintenance tick.
func (d *DB) CleanupExpiredSecondFactorState(ctx context.Context) error {
	now := secondFactorTime(time.Now())
	var errs []error
	if err := d.q.CleanupExpiredPartialAuthChallenges(ctx, now); err != nil {
		errs = append(errs, fmt.Errorf("partial-auth challenges: %w", err))
	}
	if err := d.q.CleanupExpiredPendingTOTPEnrollments(ctx, now); err != nil {
		errs = append(errs, fmt.Errorf("pending enrolments: %w", err))
	}
	if err := d.q.CleanupExpiredUsedTOTPCodes(ctx, now); err != nil {
		errs = append(errs, fmt.Errorf("used codes: %w", err))
	}
	if len(errs) > 0 {
		return fmt.Errorf("CleanupExpiredSecondFactorState: %w", errors.Join(errs...))
	}
	return nil
}

// ── Recovery codes ────────────────────────────────────────────────────────────

// ReplaceRecoveryCodes drops the user's current set and stores a new one in
// one transaction, so a regeneration can never leave both sets live or
// neither.
func (d *DB) ReplaceRecoveryCodes(ctx context.Context, userID int64, codeHashes []string) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("ReplaceRecoveryCodes begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := d.q.WithTx(tx)
	if err := q.DeleteRecoveryCodes(ctx, userID); err != nil {
		return fmt.Errorf("ReplaceRecoveryCodes delete: %w", err)
	}
	now := secondFactorTime(time.Now())
	for _, h := range codeHashes {
		if err := q.InsertRecoveryCode(ctx, dbgen.InsertRecoveryCodeParams{UserID: userID, CodeHash: h, CreatedAt: now}); err != nil {
			return fmt.Errorf("ReplaceRecoveryCodes insert: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("ReplaceRecoveryCodes commit: %w", err)
	}
	return nil
}

// ListUnusedRecoveryCodes returns the ids and hashes of the codes still
// available to the user, oldest first, as parallel slices.
func (d *DB) ListUnusedRecoveryCodes(ctx context.Context, userID int64) (ids []int64, hashes []string, err error) {
	rows, err := d.q.ListUnusedRecoveryCodes(ctx, userID)
	if err != nil {
		return nil, nil, fmt.Errorf("ListUnusedRecoveryCodes: %w", err)
	}
	ids = make([]int64, 0, len(rows))
	hashes = make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
		hashes = append(hashes, r.CodeHash)
	}
	return ids, hashes, nil
}

// MarkRecoveryCodeUsed spends one code and reports whether this call was
// the one that spent it — the conditional update is what makes a code
// single-use under concurrent verifications.
func (d *DB) MarkRecoveryCodeUsed(ctx context.Context, id int64) (bool, error) {
	now := secondFactorTime(time.Now())
	res, err := d.q.MarkRecoveryCodeUsed(ctx, dbgen.MarkRecoveryCodeUsedParams{UsedAt: &now, ID: id})
	if err != nil {
		return false, fmt.Errorf("MarkRecoveryCodeUsed: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("MarkRecoveryCodeUsed: %w", err)
	}
	return n > 0, nil
}

// CountUnusedRecoveryCodes reports how many codes the user has left.
func (d *DB) CountUnusedRecoveryCodes(ctx context.Context, userID int64) (int, error) {
	n, err := d.q.CountUnusedRecoveryCodes(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("CountUnusedRecoveryCodes: %w", err)
	}
	return int(n), nil
}

// DeleteRecoveryCodes removes every code of the user (2FA disabled, erasure).
func (d *DB) DeleteRecoveryCodes(ctx context.Context, userID int64) error {
	if err := d.q.DeleteRecoveryCodes(ctx, userID); err != nil {
		return fmt.Errorf("DeleteRecoveryCodes: %w", err)
	}
	return nil
}
