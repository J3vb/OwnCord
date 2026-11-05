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

// CreateUser inserts a new user record and returns the assigned ID.
func (d *DB) CreateUser(ctx context.Context, username, passwordHash string, roleID int) (int64, error) {
	res, err := d.writer.ExecContext(ctx,
		`INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)`,
		username, passwordHash, roleID,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateUser: %w", err)
	}
	return res.LastInsertId()
}

// The durable first-run gate. SetupCompletedKey is written in the same
// transaction as the first owner and never cleared by the server; an operator
// re-opens the wizard by setting it to SetupOpen (docs/security.md, "First-run
// setup"). Any other value counts as closed, since this gates an
// unauthenticated endpoint.
const (
	SetupCompletedKey = "setup_completed"
	SetupOpen         = "0"
	SetupClosed       = "1"
)

// CloseSetupGate records that this installation has been set up, whatever the
// users table says. The erasure markers call it at start-up: a marker lives
// outside the database a restore overwrites, and a backup taken before the
// first owner rolls both the users table and the flag back, which would
// reopen the unauthenticated setup endpoint. Idempotent.
func (d *DB) CloseSetupGate(ctx context.Context) error {
	if _, err := d.writer.ExecContext(ctx,
		`INSERT INTO settings (key, value) VALUES (?1, ?2)
		 ON CONFLICT(key) DO UPDATE SET value = ?2 WHERE settings.value <> ?2`,
		SetupCompletedKey, SetupClosed); err != nil {
		return fmt.Errorf("CloseSetupGate: %w", err)
	}
	return nil
}

// CreateOwnerIfEmpty checks that no users exist and inserts the first owner in
// one transaction, closing the TOCTOU race in the setup endpoint. It returns
// ErrConflict if any user exists.
func (d *DB) CreateOwnerIfEmpty(ctx context.Context, username, passwordHash string, roleID int) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// The durable gate: setup_completed is set by the first owner's creation and
	// never cleared by the server, so an emptied users table (an erasure, or a
	// marker replay past the last-admin guard) cannot reopen the unauthenticated
	// setup endpoint. It is read inside this transaction like the count, so two
	// concurrent requests cannot both pass.
	//
	// Only SetupOpen lets the count decide; any other value is corruption or a
	// guess at the schema and refuses. A missing row is the exception, being what
	// a pre-migration database looks like.
	var completed string
	switch err := tx.QueryRow(`SELECT value FROM settings WHERE key = ?`, SetupCompletedKey).Scan(&completed); {
	case errors.Is(err, sql.ErrNoRows):
		// A database from before the migration: the count is the gate.
	case err != nil:
		return 0, fmt.Errorf("CreateOwnerIfEmpty setup flag: %w", err)
	case completed != SetupOpen:
		return 0, ErrConflict
	}

	var count int64
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users WHERE registration_status <> 'system'`).Scan(&count); err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty count: %w", err)
	}
	if count > 0 {
		return 0, ErrConflict
	}

	res, err := tx.Exec(
		`INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)`,
		username, passwordHash, roleID,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty insert: %w", err)
	}

	uid, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty last_id: %w", err)
	}

	// Setup closes at this commit, in the same transaction as the owner.
	if _, err := tx.Exec(
		`INSERT INTO settings (key, value) VALUES (?1, ?2)
		 ON CONFLICT(key) DO UPDATE SET value = ?2`, SetupCompletedKey, SetupClosed); err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty setup flag: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty commit: %w", err)
	}
	return uid, nil
}

// CreateUserWithInvite consumes an invite, creates the user and inserts the
// first session in one transaction, so a failure leaves no half-registered
// account and does not burn the invite. sessionTokenHash must already be
// hashed. No session-cap eviction is needed: the user has no sessions yet.
func (d *DB) CreateUserWithInvite(ctx context.Context, username, passwordHash string, roleID int, inviteCode, sessionTokenHash, device, ip string) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	result, err := tx.Exec(
		`UPDATE invites SET use_count = use_count + 1
		 WHERE code = ? AND revoked = 0
		 AND (max_uses IS NULL OR use_count < max_uses)
		 AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'))`,
		inviteCode,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite use invite: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite invite rows: %w", err)
	}
	if rows == 0 {
		return 0, fmt.Errorf("CreateUserWithInvite invite unavailable: %w", ErrNotFound)
	}

	result, err = tx.Exec(
		`INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)`,
		username, passwordHash, roleID,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite create user: %w", err)
	}
	uid, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite last insert id: %w", err)
	}
	// The redemption record commits with the account and the invite's use_count,
	// so a leaked invite can be traced to its redeemer; a failure rolls back the
	// whole registration.
	if err := d.q.WithTx(tx).CreateInviteRedemption(ctx, dbgen.CreateInviteRedemptionParams{
		UserID: &uid,
		Code:   inviteCode,
	}); err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite record redemption: %w", err)
	}
	if _, err := insertSession(ctx, d.q.WithTx(tx), uid, sessionTokenHash, device, ip, false); err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite create session: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite commit: %w", err)
	}
	return uid, nil
}

// CreateUserWithSession creates the account and its first session in one
// transaction (open-mode registration, no invite consumed); a failure leaves
// no half-registered account. sessionTokenHash must already be hashed.
func (d *DB) CreateUserWithSession(ctx context.Context, username, passwordHash string, roleID int, sessionTokenHash, device, ip string) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithSession begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	result, err := tx.Exec(
		`INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)`,
		username, passwordHash, roleID,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithSession create user: %w", err)
	}
	uid, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithSession last insert id: %w", err)
	}
	if _, err := insertSession(ctx, d.q.WithTx(tx), uid, sessionTokenHash, device, ip, false); err != nil {
		return 0, fmt.Errorf("CreateUserWithSession create session: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("CreateUserWithSession commit: %w", err)
	}
	return uid, nil
}

// GetUserByUsername returns the user with the given username (case-insensitive),
// or nil if not found.
func (d *DB) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	u, err := d.q.GetUserByUsername(ctx, username)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetUserByUsername: %w", err)
	}
	return userFromGen(u), nil
}

// GetUserByID returns the user with the given ID, or nil if not found.
func (d *DB) GetUserByID(ctx context.Context, id int64) (*User, error) {
	u, err := d.q.GetUserByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetUserByID: %w", err)
	}
	return userFromGen(u), nil
}

// UpdateUserStatus sets the status column for the given user ID.
func (d *DB) UpdateUserStatus(ctx context.Context, id int64, status string) error {
	if err := d.q.UpdateUserStatus(ctx, dbgen.UpdateUserStatusParams{
		Status: status,
		ID:     id,
	}); err != nil {
		return fmt.Errorf("UpdateUserStatus: %w", err)
	}
	return nil
}

// UpdateUserTOTPSecret sets or clears the TOTP secret for a user.
func (d *DB) UpdateUserTOTPSecret(ctx context.Context, id int64, secret *string) error {
	if err := d.q.UpdateUserTOTPSecret(ctx, dbgen.UpdateUserTOTPSecretParams{
		TotpSecret: secret,
		ID:         id,
	}); err != nil {
		return fmt.Errorf("UpdateUserTOTPSecret: %w", err)
	}
	return nil
}

// UserTOTPSecret is one stored TOTP secret, exactly as the column holds it.
type UserTOTPSecret struct {
	UserID int64
	Stored string
}

// ListUserTOTPSecrets returns every non-NULL stored TOTP secret, by user id.
func (d *DB) ListUserTOTPSecrets(ctx context.Context) ([]UserTOTPSecret, error) {
	rows, err := d.q.ListUserTOTPSecrets(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListUserTOTPSecrets: %w", err)
	}
	out := make([]UserTOTPSecret, 0, len(rows))
	for _, r := range rows {
		if r.TotpSecret != nil {
			out = append(out, UserTOTPSecret{UserID: r.ID, Stored: *r.TotpSecret})
		}
	}
	return out, nil
}

// ReplaceUserTOTPSecret swaps a user's stored TOTP secret from old to next and
// reports whether it did: false means the row no longer holds old (a
// concurrent enable or disable won), and nothing was written.
func (d *DB) ReplaceUserTOTPSecret(ctx context.Context, userID int64, old, next string) (bool, error) {
	n, err := d.q.ReplaceUserTOTPSecret(ctx, dbgen.ReplaceUserTOTPSecretParams{
		NewSecret: &next,
		ID:        userID,
		OldSecret: &old,
	})
	if err != nil {
		return false, fmt.Errorf("ReplaceUserTOTPSecret: %w", err)
	}
	return n == 1, nil
}

// UpdateUserIdentityKey sets or clears the E2EE identity public key. Last
// write wins; the service audits key changes so peers can detect a rotation.
func (d *DB) UpdateUserIdentityKey(ctx context.Context, id int64, key *string) error {
	if err := d.q.UpdateUserIdentityKey(ctx, dbgen.UpdateUserIdentityKeyParams{
		IdentityPublicKey: key,
		ID:                id,
	}); err != nil {
		return fmt.Errorf("UpdateUserIdentityKey: %w", err)
	}
	return nil
}

// ResetAllUserStatuses clears the "online" status left by a previous run or
// crash, at startup. Chosen statuses (idle/dnd/invisible) stay: they are what
// the user picked, and the read path already shows a user with no connection
// as offline.
func (d *DB) ResetAllUserStatuses(ctx context.Context) error {
	if err := d.q.ResetAllUserStatuses(ctx); err != nil {
		return fmt.Errorf("ResetAllUserStatuses: %w", err)
	}
	return nil
}

// BanUser marks a user as banned with an optional expiry. Pass nil for a
// permanent ban.
func (d *DB) BanUser(ctx context.Context, id int64, reason string, expires *time.Time) error {
	var expiresStr *string
	if expires != nil {
		s := expires.UTC().Format(dbtime.ISOLayout)
		expiresStr = &s
	}
	reasonCopy := reason
	if err := d.q.BanUser(ctx, dbgen.BanUserParams{
		BanReason:  &reasonCopy,
		BanExpires: expiresStr,
		ID:         id,
	}); err != nil {
		return fmt.Errorf("BanUser: %w", err)
	}
	return nil
}

// UnbanUser removes the ban from a user.
func (d *DB) UnbanUser(ctx context.Context, id int64) error {
	if err := d.q.UnbanUser(ctx, id); err != nil {
		return fmt.Errorf("UnbanUser: %w", err)
	}
	return nil
}

// FormatMemberCreatedAt renders a users.created_at value (SQLite's
// datetime('now') text, "2006-01-02 15:04:05", or an RFC 3339 instant) in the
// member wire layout, so member_join and ready.members[] agree. A value it
// cannot parse is returned unchanged.
func FormatMemberCreatedAt(raw string) string {
	if t, ok := dbtime.Parse(raw); ok {
		return t.Format(dbtime.ISOLayout)
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t.UTC().Format(dbtime.ISOLayout)
	}
	return raw
}

// MemberGeneration returns a counter that SQLite triggers bump, in the same
// commit, on every write that can change ListMembers' result except a
// users.status change. Equal generations mean no such write committed between.
func (d *DB) MemberGeneration(ctx context.Context) (int64, error) {
	gen, err := d.q.GetMemberGeneration(ctx)
	if err != nil {
		return 0, fmt.Errorf("MemberGeneration: %w", err)
	}
	return gen, nil
}

// NextMemberBanLapse returns when the earliest temporary ban ListMembers still
// hides lapses, as "2006-01-02T15:04:05Z"-shaped text ListMembers compares
// against SQLite's clock, or "" when none is pending. A lapse changes the
// result without a write, so it bumps no generation.
func (d *DB) NextMemberBanLapse(ctx context.Context) (string, error) {
	at, err := d.q.NextMemberBanLapse(ctx)
	if err != nil {
		return "", fmt.Errorf("NextMemberBanLapse: %w", err)
	}
	return at, nil
}
