package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// RecoveryKit is the server's whole knowledge of an account's recovery kit:
// an argon2id verifier, when it was issued, and whether it was spent.
type RecoveryKit struct {
	UserID    int64
	Verifier  string `json:"-"`
	CreatedAt string
	UsedAt    *string
}

// ErrRecoveryKitSpent is RedeemRecoveryKit finding no unspent kit for the
// account — already used, never issued, or replaced since the compare.
var ErrRecoveryKitSpent = errors.New("recovery kit already spent or absent")

// UpsertRecoveryKit stores the verifier of a freshly issued kit, replacing
// and un-spending any previous one: one active kit per account.
func (d *DB) UpsertRecoveryKit(ctx context.Context, userID int64, verifier string) error {
	if err := d.q.UpsertRecoveryKit(ctx, dbgen.UpsertRecoveryKitParams{
		UserID:    userID,
		Verifier:  verifier,
		CreatedAt: time.Now().UTC().Format(dbtime.ISOLayout),
	}); err != nil {
		return fmt.Errorf("UpsertRecoveryKit: %w", err)
	}
	return nil
}

// GetRecoveryKit returns the account's kit row, or nil when none was issued.
func (d *DB) GetRecoveryKit(ctx context.Context, userID int64) (*RecoveryKit, error) {
	row, err := d.q.GetRecoveryKit(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetRecoveryKit: %w", err)
	}
	return &RecoveryKit{UserID: row.UserID, Verifier: row.Verifier, CreatedAt: row.CreatedAt, UsedAt: row.UsedAt}, nil
}

// DeleteRecoveryKit removes the account's kit (a rotation to "none").
func (d *DB) DeleteRecoveryKit(ctx context.Context, userID int64) error {
	if err := d.q.DeleteRecoveryKit(ctx, userID); err != nil {
		return fmt.Errorf("DeleteRecoveryKit: %w", err)
	}
	return nil
}

// RedeemRecoveryKit is the whole state change of a successful recovery in
// one transaction (data-lifecycle O8, axis A1): the kit is spent, the
// password replaced, every session and API token of the account revoked and
// the audit row written with both counts, or none of it. The consume is
// conditional on the kit being unspent and still holding the verifier the
// caller compared against, so two concurrent redemptions admit at most one
// and a kit enrolled meanwhile stays; the loser gets ErrRecoveryKitSpent.
func (d *DB) RedeemRecoveryKit(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (sessionsRevoked int64, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)

	now := time.Now().UTC().Format(dbtime.ISOLayout)
	res, err := q.ConsumeRecoveryKit(ctx, dbgen.ConsumeRecoveryKitParams{UsedAt: &now, UserID: userID, Verifier: verifier})
	if err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit consume: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit consume rows: %w", err)
	} else if n == 0 {
		return 0, ErrRecoveryKitSpent
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET password = ? WHERE id = ?`, newPasswordHash, userID); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit password: %w", err)
	}
	revoked, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID)
	if err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit sessions: %w", err)
	}
	sessionsRevoked, _ = revoked.RowsAffected()
	tokens, err := q.RevokeUserAPITokens(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit api tokens: %w", err)
	}
	tokensRevoked, _ := tokens.RowsAffected()
	// A recovery by kit withdraws any owner-issued credential still
	// outstanding for the account: the situation it was issued for
	// is over.
	if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_assists WHERE user_id = ?`, userID); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit withdraw credential: %w", err)
	}
	if err := q.LogAudit(ctx, dbgen.LogAuditParams{
		ActorID: userID, Action: auditAction, TargetType: "user", TargetID: userID,
		Detail: fmt.Sprintf("%s (%d sessions, %d API tokens revoked)", auditDetail, sessionsRevoked, tokensRevoked),
	}); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("RedeemRecoveryKit commit: %w", err)
	}
	return sessionsRevoked, nil
}
