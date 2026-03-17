package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// ─── User Operations ──────────────────────────────────────────────────────────

// CreateUser inserts a new user record and returns the assigned ID.
func (d *DB) CreateUser(username, passwordHash string, roleID int) (int64, error) {
	res, err := d.sqlDB.Exec(
		`INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)`,
		username, passwordHash, roleID,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateUser: %w", err)
	}
	return res.LastInsertId()
}

// GetUserByUsername returns the user with the given username (case-insensitive),
// or nil if not found.
func (d *DB) GetUserByUsername(username string) (*User, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, username, password, avatar, role_id, totp_secret, status,
		        created_at, last_seen, banned, ban_reason, ban_expires
		 FROM users WHERE username = ? COLLATE NOCASE`,
		username,
	)
	return scanUser(row)
}

// GetUserByID returns the user with the given ID, or nil if not found.
func (d *DB) GetUserByID(id int64) (*User, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, username, password, avatar, role_id, totp_secret, status,
		        created_at, last_seen, banned, ban_reason, ban_expires
		 FROM users WHERE id = ?`,
		id,
	)
	return scanUser(row)
}

// scanUser reads a User from a *sql.Row, returning nil (not an error) when the
// row is not found.
func scanUser(row *sql.Row) (*User, error) {
	u := &User{}
	var banned int
	err := row.Scan(
		&u.ID, &u.Username, &u.PasswordHash, &u.Avatar, &u.RoleID,
		&u.TOTPSecret, &u.Status, &u.CreatedAt, &u.LastSeen,
		&banned, &u.BanReason, &u.BanExpires,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scanUser: %w", err)
	}
	u.Banned = banned != 0
	return u, nil
}

// UpdateUserStatus sets the status column for the given user ID.
func (d *DB) UpdateUserStatus(id int64, status string) error {
	_, err := d.sqlDB.Exec(
		`UPDATE users SET status = ?, last_seen = datetime('now') WHERE id = ?`,
		status, id,
	)
	if err != nil {
		return fmt.Errorf("UpdateUserStatus: %w", err)
	}
	return nil
}

// ResetAllUserStatuses sets all users to "offline". Called on server startup
// to clear stale statuses from a previous run or crash.
func (d *DB) ResetAllUserStatuses() error {
	_, err := d.sqlDB.Exec(`UPDATE users SET status = 'offline' WHERE status != 'offline'`)
	if err != nil {
		return fmt.Errorf("ResetAllUserStatuses: %w", err)
	}
	return nil
}

// BanUser marks a user as banned with an optional expiry. Pass nil for a
// permanent ban.
func (d *DB) BanUser(id int64, reason string, expires *time.Time) error {
	var expiresStr *string
	if expires != nil {
		s := expires.UTC().Format("2006-01-02T15:04:05Z")
		expiresStr = &s
	}
	_, err := d.sqlDB.Exec(
		`UPDATE users SET banned = 1, ban_reason = ?, ban_expires = ? WHERE id = ?`,
		reason, expiresStr, id,
	)
	if err != nil {
		return fmt.Errorf("BanUser: %w", err)
	}
	return nil
}

// UnbanUser removes the ban from a user.
func (d *DB) UnbanUser(id int64) error {
	_, err := d.sqlDB.Exec(
		`UPDATE users SET banned = 0, ban_reason = NULL, ban_expires = NULL WHERE id = ?`,
		id,
	)
	if err != nil {
		return fmt.Errorf("UnbanUser: %w", err)
	}
	return nil
}

// ─── Session Operations ───────────────────────────────────────────────────────

// CreateSession inserts a new session and returns the session ID.
// tokenHash must already be hashed (never store plaintext tokens).
func (d *DB) CreateSession(userID int64, tokenHash, device, ip string) (int64, error) {
	expiresAt := time.Now().Add(sessionTTL).UTC().Format("2006-01-02T15:04:05Z")
	res, err := d.sqlDB.Exec(
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 VALUES (?, ?, ?, ?, ?)`,
		userID, tokenHash, device, ip, expiresAt,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateSession: %w", err)
	}
	return res.LastInsertId()
}

// GetSessionByTokenHash retrieves a session by its hashed token, or nil if
// not found.
func (d *DB) GetSessionByTokenHash(tokenHash string) (*Session, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at
		 FROM sessions WHERE token = ?`,
		tokenHash,
	)
	s := &Session{}
	err := row.Scan(
		&s.ID, &s.UserID, &s.TokenHash, &s.Device, &s.IP,
		&s.CreatedAt, &s.LastUsed, &s.ExpiresAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetSessionByTokenHash: %w", err)
	}
	return s, nil
}

// DeleteSession removes the session with the given token hash.
func (d *DB) DeleteSession(tokenHash string) error {
	_, err := d.sqlDB.Exec(`DELETE FROM sessions WHERE token = ?`, tokenHash)
	if err != nil {
		return fmt.Errorf("DeleteSession: %w", err)
	}
	return nil
}

// DeleteExpiredSessions removes all sessions whose expires_at is in the past.
// Compares using strftime to handle both ISO-8601 and SQLite datetime formats.
func (d *DB) DeleteExpiredSessions() error {
	_, err := d.sqlDB.Exec(
		`DELETE FROM sessions WHERE strftime('%s', expires_at) < strftime('%s', 'now')`,
	)
	if err != nil {
		return fmt.Errorf("DeleteExpiredSessions: %w", err)
	}
	return nil
}

// TouchSession updates last_used for the session with the given token hash.
func (d *DB) TouchSession(tokenHash string) error {
	_, err := d.sqlDB.Exec(
		`UPDATE sessions SET last_used = datetime('now') WHERE token = ?`,
		tokenHash,
	)
	if err != nil {
		return fmt.Errorf("TouchSession: %w", err)
	}
	return nil
}

// ─── Invite Operations ────────────────────────────────────────────────────────

// CreateInvite generates a random invite code, persists it, and returns the
// code. maxUses=0 means unlimited. expiresAt=nil means never expires.
func (d *DB) CreateInvite(createdBy int64, maxUses int, expiresAt *time.Time) (string, error) {
	code, err := generateInviteCode()
	if err != nil {
		return "", fmt.Errorf("CreateInvite generate code: %w", err)
	}

	var maxUsesVal *int
	if maxUses > 0 {
		maxUsesVal = &maxUses
	}
	var expiresStr *string
	if expiresAt != nil {
		s := expiresAt.UTC().Format("2006-01-02T15:04:05Z")
		expiresStr = &s
	}

	_, err = d.sqlDB.Exec(
		`INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?)`,
		code, createdBy, maxUsesVal, expiresStr,
	)
	if err != nil {
		return "", fmt.Errorf("CreateInvite insert: %w", err)
	}
	return code, nil
}

// GetInvite returns the invite for the given code, or nil if not found.
func (d *DB) GetInvite(code string) (*Invite, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, code, created_by, max_uses, use_count, expires_at, revoked, created_at
		 FROM invites WHERE code = ?`,
		code,
	)
	inv := &Invite{}
	var revoked int
	err := row.Scan(
		&inv.ID, &inv.Code, &inv.CreatedBy, &inv.MaxUses,
		&inv.Uses, &inv.ExpiresAt, &revoked, &inv.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetInvite: %w", err)
	}
	inv.Revoked = revoked != 0
	return inv, nil
}

// UseInviteAtomic validates and increments the use_count in a single SQL
// statement, eliminating the TOCTOU race that exists when GetInvite and
// UseInvite are called as separate operations.
//
// The UPDATE only matches rows where:
//   - the code exists
//   - revoked = 0
//   - max_uses IS NULL (unlimited) OR uses < max_uses
//   - expires_at IS NULL (never) OR expires_at > now
//
// If zero rows are affected the invite is missing, revoked, expired, or
// exhausted — an error is returned in all such cases.
func (d *DB) UseInviteAtomic(code string) error {
	result, err := d.sqlDB.Exec(
		`UPDATE invites SET use_count = use_count + 1
		 WHERE code = ? AND revoked = 0
		 AND (max_uses IS NULL OR use_count < max_uses)
		 AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'))`,
		code,
	)
	if err != nil {
		return fmt.Errorf("UseInviteAtomic: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("UseInviteAtomic rows: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("UseInviteAtomic: invite not found, revoked, expired, or exhausted")
	}
	return nil
}

// RevokeInvite marks an invite as revoked.
func (d *DB) RevokeInvite(code string) error {
	_, err := d.sqlDB.Exec(`UPDATE invites SET revoked = 1 WHERE code = ?`, code)
	if err != nil {
		return fmt.Errorf("RevokeInvite: %w", err)
	}
	return nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// MemberSummary is a lightweight user shape for the ready payload.
type MemberSummary struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	Status   string  `json:"status"`
	Role     string  `json:"role"`
}

// ListMembers returns all non-banned users as lightweight summaries.
func (d *DB) ListMembers() ([]MemberSummary, error) {
	rows, err := d.sqlDB.Query(
		`SELECT u.id, u.username, u.avatar, u.status, r.name
		 FROM users u
		 JOIN roles r ON u.role_id = r.id
		 WHERE u.banned = 0
		 ORDER BY u.username ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("ListMembers: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var members []MemberSummary
	for rows.Next() {
		var m MemberSummary
		if err := rows.Scan(&m.ID, &m.Username, &m.Avatar, &m.Status, &m.Role); err != nil {
			return nil, fmt.Errorf("ListMembers scan: %w", err)
		}
		members = append(members, m)
	}
	if members == nil {
		members = []MemberSummary{}
	}
	return members, nil
}

// generateInviteCode produces a random 8-byte (16-char hex) code.
func generateInviteCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
