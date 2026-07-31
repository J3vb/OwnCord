package db

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/owncord/server/db/dbgen"
)

// ─── User Operations ──────────────────────────────────────────────────────────

// CreateUser inserts a new user record and returns the assigned ID.
func (d *DB) CreateUser(ctx context.Context, username, passwordHash string, roleID int) (int64, error) {
	res, err := d.sqlDB.ExecContext(ctx,
		`INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)`,
		username, passwordHash, roleID,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateUser: %w", err)
	}
	return res.LastInsertId()
}

// CreateOwnerIfEmpty atomically checks that no users exist and inserts the
// first owner in a single transaction. Returns ErrConflict if any user already
// exists, closing the TOCTOU race in the setup endpoint (BUG-119).
func (d *DB) CreateOwnerIfEmpty(ctx context.Context, username, passwordHash string, roleID int) (int64, error) {
	tx, err := d.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	var count int64
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
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

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty commit: %w", err)
	}
	committed = true
	return uid, nil
}

// CreateUserWithInvite atomically consumes an invite and creates the user in
// the same transaction so a failed registration does not burn the invite.
func (d *DB) CreateUserWithInvite(ctx context.Context, username, passwordHash string, roleID int, inviteCode string) (int64, error) {
	tx, err := d.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

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
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite commit: %w", err)
	}
	committed = true
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

// UpdateUserIdentityKey sets or clears the E2EE identity public key for a user
// (F3 voice E2EE TOFU). Last write wins; key changes are audited at the
// service layer so peers can detect a rotation.
func (d *DB) UpdateUserIdentityKey(ctx context.Context, id int64, key *string) error {
	if err := d.q.UpdateUserIdentityKey(ctx, dbgen.UpdateUserIdentityKeyParams{
		IdentityPublicKey: key,
		ID:                id,
	}); err != nil {
		return fmt.Errorf("UpdateUserIdentityKey: %w", err)
	}
	return nil
}

// ResetAllUserStatuses sets all users to "offline". Called on server startup
// to clear stale statuses from a previous run or crash.
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
		s := expires.UTC().Format("2006-01-02T15:04:05Z")
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

// ─── Session Operations ───────────────────────────────────────────────────────

// maxSessionsPerUser is the maximum number of concurrent sessions allowed per
// user. When exceeded, the oldest session is evicted. This prevents unbounded
// session accumulation from credential stuffing or token theft (H-6).
const maxSessionsPerUser = 25

// CreateSession inserts a new session and returns the session ID.
// tokenHash must already be hashed (never store plaintext tokens).
// H-6: Enforces a per-user session cap by evicting the oldest session when
// the limit is reached.
func (d *DB) CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error) {
	// Evict oldest sessions if at or above the cap.
	_ = d.q.EvictOldestSessions(ctx, dbgen.EvictOldestSessionsParams{
		UserID: userID,
		Offset: maxSessionsPerUser - 1,
	})

	expiresAt := time.Now().Add(sessionTTL).UTC().Format("2006-01-02T15:04:05Z")
	deviceCopy, ipCopy := device, ip
	res, err := d.q.InsertSession(ctx, dbgen.InsertSessionParams{
		UserID:    userID,
		Token:     tokenHash,
		Device:    &deviceCopy,
		IpAddress: &ipCopy,
		ExpiresAt: expiresAt,
	})
	if err != nil {
		return 0, fmt.Errorf("CreateSession: %w", err)
	}
	return res.LastInsertId()
}

// GetSessionByTokenHash retrieves a session by its hashed token, or nil if
// not found.
func (d *DB) GetSessionByTokenHash(ctx context.Context, tokenHash string) (*Session, error) {
	s, err := d.q.GetSessionByTokenHash(ctx, tokenHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetSessionByTokenHash: %w", err)
	}
	sess := sessionFromGen(s)
	return &sess, nil
}

// SessionWithBanStatus combines session data with user ban fields
// in a single query, avoiding two sequential DB round-trips.
type SessionWithBanStatus struct {
	Session
	Banned     bool
	BanReason  *string
	BanExpires *string
}

// GetSessionWithBanStatus returns the session joined with the user's ban
// status in a single query. Returns nil, nil when not found.
func (d *DB) GetSessionWithBanStatus(ctx context.Context, tokenHash string) (*SessionWithBanStatus, error) {
	row, err := d.q.GetSessionWithBanStatus(ctx, tokenHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetSessionWithBanStatus: %w", err)
	}
	return &SessionWithBanStatus{
		Session: Session{
			ID:        row.ID,
			UserID:    row.UserID,
			TokenHash: row.Token,
			Device:    derefString(row.Device),
			IP:        derefString(row.IpAddress),
			CreatedAt: row.CreatedAt,
			LastUsed:  row.LastUsed,
			ExpiresAt: row.ExpiresAt,
		},
		Banned:     row.Banned != 0,
		BanReason:  row.BanReason,
		BanExpires: row.BanExpires,
	}, nil
}

// GetSessionsWithBanStatusBatch returns session+ban rows for every token hash
// in tokenHashes, keyed by token hash. Hashes with no session row are simply
// absent from the map. Used by the ws revoked-session sweep so N connected
// clients cost one query per sweep instead of N.
func (d *DB) GetSessionsWithBanStatusBatch(ctx context.Context, tokenHashes []string) (map[string]*SessionWithBanStatus, error) {
	result := make(map[string]*SessionWithBanStatus, len(tokenHashes))
	// Chunk the IN list to stay far below SQLite's bound-parameter limit.
	const chunkSize = 500
	for start := 0; start < len(tokenHashes); start += chunkSize {
		chunk := tokenHashes[start:min(start+chunkSize, len(tokenHashes))]

		placeholders := make([]string, len(chunk))
		args := make([]any, len(chunk))
		for i, hash := range chunk {
			placeholders[i] = "?"
			args[i] = hash
		}

		query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`SELECT s.id, s.user_id, s.token, s.device, s.ip_address,
			        s.created_at, s.last_used, s.expires_at,
			        u.banned, u.ban_reason, u.ban_expires
			 FROM sessions s
			 JOIN users u ON s.user_id = u.id
			 WHERE s.token IN (%s)`,
			strings.Join(placeholders, ","),
		)
		rows, err := d.sqlDB.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, fmt.Errorf("GetSessionsWithBanStatusBatch: %w", err)
		}
		if err := scanSessionsWithBanStatus(rows, result); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// scanSessionsWithBanStatus scans batch rows into result and closes rows.
func scanSessionsWithBanStatus(rows *sql.Rows, result map[string]*SessionWithBanStatus) error {
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var s SessionWithBanStatus
		var device, ip *string
		var banned int
		if err := rows.Scan(
			&s.ID, &s.UserID, &s.TokenHash, &device, &ip,
			&s.CreatedAt, &s.LastUsed, &s.ExpiresAt,
			&banned, &s.BanReason, &s.BanExpires,
		); err != nil {
			return fmt.Errorf("GetSessionsWithBanStatusBatch scan: %w", err)
		}
		s.Device = derefString(device)
		s.IP = derefString(ip)
		s.Banned = banned != 0
		result[s.TokenHash] = &s
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("GetSessionsWithBanStatusBatch rows: %w", err)
	}
	return nil
}

// DeleteSession removes the session with the given token hash.
func (d *DB) DeleteSession(ctx context.Context, tokenHash string) error {
	if err := d.q.DeleteSessionByToken(ctx, tokenHash); err != nil {
		return fmt.Errorf("DeleteSession: %w", err)
	}
	return nil
}

// DeleteOtherSessions removes all sessions for the given user except the one
// with keepSessionID. Used after password change or 2FA state change to
// invalidate all other sessions (BUG-108).
func (d *DB) DeleteOtherSessions(ctx context.Context, userID, keepSessionID int64) (int64, error) {
	result, err := d.q.DeleteOtherSessions(ctx, dbgen.DeleteOtherSessionsParams{
		UserID: userID,
		ID:     keepSessionID,
	})
	if err != nil {
		return 0, fmt.Errorf("DeleteOtherSessions: %w", err)
	}
	n, _ := result.RowsAffected()
	return n, nil
}

// DeleteExpiredSessions removes all sessions whose expires_at is in the past.
// Compares using strftime to handle both ISO-8601 and SQLite datetime formats.
func (d *DB) DeleteExpiredSessions(ctx context.Context) error {
	if err := d.q.DeleteExpiredSessions(ctx); err != nil {
		return fmt.Errorf("DeleteExpiredSessions: %w", err)
	}
	return nil
}

// TouchSession updates last_used for the session with the given token hash.
func (d *DB) TouchSession(ctx context.Context, tokenHash string) error {
	if err := d.q.TouchSession(ctx, tokenHash); err != nil {
		return fmt.Errorf("TouchSession: %w", err)
	}
	return nil
}

// ─── Invite Operations ────────────────────────────────────────────────────────

// CreateInvite generates a random invite code, persists it, and returns the
// code. maxUses=0 means unlimited. expiresAt=nil means never expires.
func (d *DB) CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresAt *time.Time) (string, error) {
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

	if err := d.q.CreateInvite(ctx, dbgen.CreateInviteParams{
		Code:      code,
		CreatedBy: createdBy,
		MaxUses:   ptrItoI64(maxUsesVal),
		ExpiresAt: expiresStr,
	}); err != nil {
		return "", fmt.Errorf("CreateInvite insert: %w", err)
	}
	return code, nil
}

// GetInvite returns the invite for the given code, or nil if not found.
func (d *DB) GetInvite(ctx context.Context, code string) (*Invite, error) {
	r, err := d.q.GetInvite(ctx, code)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetInvite: %w", err)
	}
	return &Invite{
		ID:        r.ID,
		Code:      r.Code,
		CreatedBy: r.CreatedBy,
		Uses:      int(r.UseCount),
		MaxUses:   ptrI64toI(r.MaxUses),
		ExpiresAt: r.ExpiresAt,
		Revoked:   r.Revoked != 0,
		CreatedAt: r.CreatedAt,
	}, nil
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
func (d *DB) UseInviteAtomic(ctx context.Context, code string) error {
	result, err := d.q.UseInviteAtomic(ctx, code)
	if err != nil {
		return fmt.Errorf("UseInviteAtomic: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("UseInviteAtomic rows: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("UseInviteAtomic: invite not found, revoked, expired, or exhausted: %w", ErrNotFound)
	}
	return nil
}

// RevokeInvite marks an invite as revoked.
func (d *DB) RevokeInvite(ctx context.Context, code string) error {
	if err := d.q.RevokeInvite(ctx, code); err != nil {
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
	// IdentityPublicKey is the user's long-term E2EE identity public key
	// (base64), pinned by peers on first sight (F3 TOFU). Omitted when the
	// user has not published one.
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
}

// ListMembers returns non-banned users as lightweight summaries.
// M-12: Limited to 1000 rows to prevent unbounded result sets on large servers.
func (d *DB) ListMembers(ctx context.Context) ([]MemberSummary, error) {
	rows, err := d.q.ListMembers(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListMembers: %w", err)
	}
	members := make([]MemberSummary, 0, len(rows))
	for _, r := range rows {
		members = append(members, MemberSummary{
			ID:                r.ID,
			Username:          r.Username,
			Avatar:            r.Avatar,
			Status:            r.Status,
			Role:              r.Lower,
			IdentityPublicKey: r.IdentityPublicKey,
		})
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
