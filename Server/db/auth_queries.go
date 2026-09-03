package db

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ─── User Operations ──────────────────────────────────────────────────────────

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

// The durable first-run gate (migration 043). SetupCompletedKey is written
// in the same transaction as the first owner and never cleared by the
// server; an operator re-opens the wizard by setting it back to SetupOpen
// with filesystem access to the database (docs/security.md, "First-run
// setup"). Any other value is treated as closed, this being the gate in
// front of an unauthenticated endpoint.
const (
	SetupCompletedKey = "setup_completed"
	SetupOpen         = "0"
	SetupClosed       = "1"
)

// CreateOwnerIfEmpty atomically checks that no users exist and inserts the
// first owner in a single transaction. Returns ErrConflict if any user already
// exists, closing the TOCTOU race in the setup endpoint (BUG-119).
func (d *DB) CreateOwnerIfEmpty(ctx context.Context, username, passwordHash string, roleID int) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// The durable gate (migration 043): setup_completed is set by the first
	// owner's creation below and never cleared by the server, so an emptied
	// users table — an erasure, or a marker replay past the last-admin guard
	// on a restored backup — cannot reopen the unauthenticated setup
	// endpoint. Read inside this transaction, like the count it backs up, so
	// two concurrent requests cannot both pass.
	//
	// Only SetupOpen lets the count decide. The server writes SetupClosed and
	// the documented re-open writes SetupOpen, so any other value is
	// corruption or someone's guess at the schema, and this gate stands in
	// front of an unauthenticated endpoint: an unrecognised value refuses. A
	// missing row is the one exception, being what every pre-migration
	// database looks like.
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

	// Setup is closed from this commit on, in the same transaction as the
	// owner it belongs to.
	if _, err := tx.Exec(
		`INSERT INTO settings (key, value) VALUES (?1, ?2)
		 ON CONFLICT(key) DO UPDATE SET value = ?2`, SetupCompletedKey, SetupClosed); err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty setup flag: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("CreateOwnerIfEmpty commit: %w", err)
	}
	committed = true
	return uid, nil
}

// CreateUserWithInvite atomically consumes an invite, creates the user and
// inserts the account's first session in one transaction, so a failure at any
// step — the session insert included (OC-0376) — leaves no half-registered
// account and does not burn the invite. sessionTokenHash must already be
// hashed. The H-6 session cap needs no eviction here: the user has no sessions
// yet.
func (d *DB) CreateUserWithInvite(ctx context.Context, username, passwordHash string, roleID int, inviteCode, sessionTokenHash, device, ip string) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
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
	if _, err := insertSession(ctx, d.q.WithTx(tx), uid, sessionTokenHash, device, ip, false); err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite create session: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("CreateUserWithInvite commit: %w", err)
	}
	committed = true
	return uid, nil
}

// CreateUserWithSession creates the account and its first session in one
// transaction — open-mode registration (B4-1), where no invite is consumed.
// Like CreateUserWithInvite, a failure at any step leaves no half-registered
// account (OC-0376). sessionTokenHash must already be hashed.
func (d *DB) CreateUserWithSession(ctx context.Context, username, passwordHash string, roleID int, sessionTokenHash, device, ip string) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateUserWithSession begin: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

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
	committed = true
	return uid, nil
}

// ErrPendingQueueFull is CreatePendingUser refusing the application because
// the approval queue already holds maxPending rows.
var ErrPendingQueueFull = errors.New("approval queue is full")

// CreatePendingUser records an approval-mode application (B4-1): the account
// row exists, holding the username, as registration_status = 'pending' with
// no session, so it cannot sign in until ApprovePendingUser. The queue cap is
// enforced by the insert itself (one serialized statement), so concurrent
// applications cannot overshoot it; ErrPendingQueueFull when it is full.
func (d *DB) CreatePendingUser(ctx context.Context, username, passwordHash string, roleID, maxPending int) (int64, error) {
	res, err := d.q.CreatePendingUser(ctx, dbgen.CreatePendingUserParams{
		Username:   username,
		Password:   passwordHash,
		RoleID:     int64(roleID),
		MaxPending: int64(maxPending),
	})
	if err != nil {
		return 0, fmt.Errorf("CreatePendingUser: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("CreatePendingUser rows: %w", err)
	}
	if n == 0 {
		return 0, ErrPendingQueueFull
	}
	return res.LastInsertId()
}

// PendingUser is one approval-mode application as the admin queue lists it.
type PendingUser struct {
	ID        int64
	Username  string
	CreatedAt string
}

// ListPendingUsers returns the approval queue, oldest application first.
func (d *DB) ListPendingUsers(ctx context.Context, limit, offset int) ([]PendingUser, error) {
	rows, err := d.q.ListPendingUsers(ctx, dbgen.ListPendingUsersParams{Limit: int64(limit), Offset: int64(offset)})
	if err != nil {
		return nil, fmt.Errorf("ListPendingUsers: %w", err)
	}
	out := make([]PendingUser, 0, len(rows))
	for _, r := range rows {
		out = append(out, PendingUser{ID: r.ID, Username: r.Username, CreatedAt: r.CreatedAt})
	}
	return out, nil
}

// CountPendingUsers returns the approval queue's length.
func (d *DB) CountPendingUsers(ctx context.Context) (int64, error) {
	n, err := d.q.CountPendingUsers(ctx)
	if err != nil {
		return 0, fmt.Errorf("CountPendingUsers: %w", err)
	}
	return n, nil
}

// ApprovePendingUser unlocks an application. ErrNotFound when the id is not a
// pending application (already decided, or never one).
func (d *DB) ApprovePendingUser(ctx context.Context, userID int64) error {
	res, err := d.q.ApprovePendingUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("ApprovePendingUser: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("ApprovePendingUser rows: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// anonymiseNameAttempts is how many names DenyPendingUser will try: the
// canonical "[denied-<id>]" plus randomly suffixed variants. Exhausting it
// means the generator collided repeatedly, which is not something an
// attacker can force.
const anonymiseNameAttempts = 4

// DenyPendingUser denies an application: the row is anonymised (the username
// is released as "[denied-{id}]", the password and profile cleared) and locked
// as 'denied' for good — the convention the pre-B4-9 account deletion used,
// because audit rows reference the id. Only a still-pending row is touched;
// an approved account never goes through here. ErrNotFound when nothing
// pending matches.
func (d *DB) DenyPendingUser(ctx context.Context, userID int64) error {
	// users.username is UNIQUE COLLATE NOCASE and the "[denied-…]" namespace
	// is reserved at registration (auth.ValidateUsername), but a row from
	// before the reservation could hold the plain name; fall back to randomly
	// suffixed variants rather than leave the application pending.
	var lastErr error
	for attempt := range anonymiseNameAttempts {
		name := fmt.Sprintf("[denied-%d]", userID)
		if attempt > 0 {
			suffix := make([]byte, 6)
			if _, err := rand.Read(suffix); err != nil {
				return fmt.Errorf("DenyPendingUser suffix: %w", err)
			}
			name = fmt.Sprintf("[denied-%d-%s]", userID, hex.EncodeToString(suffix))
		}
		res, err := d.q.DenyPendingUser(ctx, dbgen.DenyPendingUserParams{Username: name, ID: userID})
		if err == nil {
			n, err := res.RowsAffected()
			if err != nil {
				return fmt.Errorf("DenyPendingUser rows: %w", err)
			}
			if n == 0 {
				return ErrNotFound
			}
			return nil
		}
		if !IsUniqueConstraintError(err) {
			return fmt.Errorf("DenyPendingUser: %w", err)
		}
		lastErr = err
	}
	return fmt.Errorf("DenyPendingUser: %w", lastErr)
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

// ResetAllUserStatuses clears the "online" status left behind by a previous
// run or crash. Called on server startup. Chosen statuses (idle/dnd/invisible)
// are left standing — they are what the user picked, not evidence of a session,
// and the read path already renders a user with no live connection as offline.
func (d *DB) ResetAllUserStatuses(ctx context.Context) error {
	if err := d.q.ResetAllUserStatuses(ctx); err != nil {
		return fmt.Errorf("ResetAllUserStatuses: %w", err)
	}
	return nil
}

// MarkUserDisconnected records that a user's last session went away: last_seen
// is refreshed and "online" falls back to "offline", while a chosen
// idle/dnd/invisible is preserved for the next connect to honour.
func (d *DB) MarkUserDisconnected(ctx context.Context, userID int64) error {
	if err := d.q.MarkUserDisconnected(ctx, userID); err != nil {
		return fmt.Errorf("MarkUserDisconnected: %w", err)
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
	// Evict oldest sessions if at or above the cap. A failed eviction must
	// not block the login (the DELETE trims to the cap again on the next
	// successful CreateSession, and a persistent DB failure fails the
	// InsertSession below anyway), but an H-6 control failing is never
	// allowed to be invisible.
	if err := d.q.EvictOldestSessions(ctx, dbgen.EvictOldestSessionsParams{
		UserID: userID,
		Offset: maxSessionsPerUser - 1,
	}); err != nil {
		slog.Warn("session cap: failed to evict oldest sessions",
			"user_id", userID, "err", err)
	}

	return insertSession(ctx, d.q, userID, tokenHash, device, ip, true)
}

// insertSession inserts one session row through q — d.q, or d.q.WithTx(tx)
// when the row must commit with other writes (CreateUserWithInvite).
// unseen marks the row as a new login the account has not acknowledged yet
// (B4-7); a registration's first session has no other device to tell.
func insertSession(ctx context.Context, q *dbgen.Queries, userID int64, tokenHash, device, ip string, unseen bool) (int64, error) {
	expiresAt := time.Now().Add(sessionTTL).UTC().Format(sessionTimeLayout)
	deviceCopy, ipCopy := device, ip
	var unseenFlag int64
	if unseen {
		unseenFlag = 1
	}
	res, err := q.InsertSession(ctx, dbgen.InsertSessionParams{
		UserID:    userID,
		Token:     tokenHash,
		Device:    &deviceCopy,
		IpAddress: &ipCopy,
		ExpiresAt: expiresAt,
		Unseen:    unseenFlag,
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
		rows, err := d.reader.QueryContext(ctx, query, args...)
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
// The comparison is plain text against idx_sessions_expires_at, so the cutoff
// MUST use sessionTimeLayout — the exact stored format (migration 031
// normalized legacy rows). A space-separated cutoff would compare wrong and
// silently delete nothing (' ' sorts before 'T').
func (d *DB) DeleteExpiredSessions(ctx context.Context) error {
	cutoff := time.Now().UTC().Format(sessionTimeLayout)
	if err := d.q.DeleteExpiredSessions(ctx, cutoff); err != nil {
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
	// DisplayName is the nickname to render instead of Username. Null when
	// unset; clients fall back to Username.
	DisplayName *string `json:"display_name"`
	// CustomStatus is the free-text status line shown under the name. Null
	// when unset.
	CustomStatus *string `json:"custom_status"`
}

// ForViewer returns a copy of the summary as viewerID may see it: an invisible
// member is offline to everyone but themselves. Ready payloads go through this
// so "who is invisible" is decided in exactly one place.
func (m MemberSummary) ForViewer(viewerID int64) MemberSummary {
	m.Status = StatusForViewer(m.Status, m.ID, viewerID)
	// A connected-but-invisible member collapses to "offline" above, but their
	// custom_status is a separate column BroadcastStatus never touches. Left
	// alone, a viewer sees {status:"offline", custom_status:"<text>"} for that
	// member while every genuinely disconnected member is
	// {status:"offline", custom_status:null} — the surviving text is a tell
	// that the member is actually online. Blank it at the same choke point
	// that collapses the status so no other caller has to remember to.
	if m.ID != viewerID && m.Status == StatusOffline {
		m.CustomStatus = nil
	}
	return m
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
			DisplayName:       r.DisplayName,
			CustomStatus:      r.CustomStatus,
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
