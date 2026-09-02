package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// RecoveryAssist is the server's whole knowledge of an owner-issued recovery
// credential (B4-6): an argon2id verifier, who issued it, the fixed wording
// of how the person was verified, and when it expires.
type RecoveryAssist struct {
	UserID       int64
	Verifier     string `json:"-"`
	IssuedBy     int64
	Verification string
	CreatedAt    string
	ExpiresAt    string
}

// Live reports whether the credential can still be redeemed at now.
func (a *RecoveryAssist) Live(now time.Time) bool {
	exp, err := time.Parse(sessionTimeLayout, a.ExpiresAt)
	return err == nil && now.UTC().Before(exp)
}

// ErrRecoveryAssistSpent is RedeemRecoveryAssist finding no live credential
// for the account: consumed, expired, replaced or never issued.
var ErrRecoveryAssistSpent = errors.New("recovery credential spent, expired or absent")

// UpsertRecoveryAssist stores the verifier of a freshly issued credential,
// replacing any outstanding one: one live credential per account.
func (d *DB) UpsertRecoveryAssist(ctx context.Context, userID int64, verifier string, issuedBy int64, verification string, expiresAt time.Time) error {
	if err := d.q.UpsertRecoveryAssist(ctx, dbgen.UpsertRecoveryAssistParams{
		UserID:       userID,
		Verifier:     verifier,
		IssuedBy:     issuedBy,
		Verification: verification,
		CreatedAt:    time.Now().UTC().Format(sessionTimeLayout),
		ExpiresAt:    expiresAt.UTC().Format(sessionTimeLayout),
	}); err != nil {
		return fmt.Errorf("UpsertRecoveryAssist: %w", err)
	}
	return nil
}

// GetRecoveryAssist returns the account's credential row, live or expired,
// or nil when none is outstanding.
func (d *DB) GetRecoveryAssist(ctx context.Context, userID int64) (*RecoveryAssist, error) {
	row, err := d.q.GetRecoveryAssist(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetRecoveryAssist: %w", err)
	}
	return &RecoveryAssist{
		UserID: row.UserID, Verifier: row.Verifier, IssuedBy: row.IssuedBy,
		Verification: row.Verification, CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt,
	}, nil
}

// DeleteRecoveryAssist withdraws an outstanding credential.
func (d *DB) DeleteRecoveryAssist(ctx context.Context, userID int64) error {
	if err := d.q.DeleteRecoveryAssist(ctx, userID); err != nil {
		return fmt.Errorf("DeleteRecoveryAssist: %w", err)
	}
	return nil
}

// RedeemRecoveryAssist is RedeemRecoveryKit for an owner-issued credential:
// the live credential is deleted, the password replaced, every session of
// the account revoked and the audit row written in one transaction, or none
// of it. The consume is conditional on the credential being live and on it
// being the very row the caller verified (its verifier), so two concurrent
// redemptions admit at most one, an expired credential admits none, and a
// credential replaced between the compare and the redeem cannot spend its
// replacement; the loser gets ErrRecoveryAssistSpent.
func (d *DB) RedeemRecoveryAssist(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (sessionsRevoked int64, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("RedeemRecoveryAssist begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	q := d.q.WithTx(tx)

	now := time.Now().UTC().Format(sessionTimeLayout)
	res, err := q.ConsumeRecoveryAssist(ctx, dbgen.ConsumeRecoveryAssistParams{UserID: userID, Verifier: verifier, ExpiresAt: now})
	if err != nil {
		return 0, fmt.Errorf("RedeemRecoveryAssist consume: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryAssist consume rows: %w", err)
	} else if n == 0 {
		return 0, ErrRecoveryAssistSpent
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET password = ? WHERE id = ?`, newPasswordHash, userID); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryAssist password: %w", err)
	}
	revoked, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID)
	if err != nil {
		return 0, fmt.Errorf("RedeemRecoveryAssist sessions: %w", err)
	}
	sessionsRevoked, _ = revoked.RowsAffected()
	if err := q.LogAudit(ctx, dbgen.LogAuditParams{
		ActorID: userID, Action: auditAction, TargetType: "user", TargetID: userID, Detail: auditDetail,
	}); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryAssist audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryAssist commit: %w", err)
	}
	committed = true
	return sessionsRevoked, nil
}
