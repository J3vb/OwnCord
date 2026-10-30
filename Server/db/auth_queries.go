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

// ErrPendingQueueFull is CreatePendingUser refusing the application because
// the approval queue already holds maxPending rows.
var ErrPendingQueueFull = errors.New("approval queue is full")

// CreatePendingUser records an approval-mode application: the account row
// exists with registration_status = 'pending' and no session, so it cannot
// sign in until ApprovePendingUser. The queue cap is enforced by the insert
// itself, so concurrent applications cannot overshoot it; ErrPendingQueueFull
// when full.
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
// pending application.
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
// canonical "[denied-<id>]" plus randomly suffixed variants.
const anonymiseNameAttempts = 4

// DenyPendingUser anonymises an application (username released as
// "[denied-{id}]", password and profile cleared) and locks it as 'denied' for
// good, because audit rows reference the id. Only a still-pending row is
// touched; ErrNotFound when nothing pending matches.
func (d *DB) DenyPendingUser(ctx context.Context, userID int64) error {
	// users.username is UNIQUE COLLATE NOCASE and the "[denied-...]" namespace is
	// reserved at registration, but an older row could hold the plain name; fall
	// back to randomly suffixed variants rather than leave the application
	// pending.
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

// maxSessionsPerUser caps concurrent sessions per user; the oldest is evicted
// beyond it, bounding accumulation from credential stuffing or token theft.
const maxSessionsPerUser = 25

// CreateSession inserts a new session and returns its ID, evicting the oldest
// session at the per-user cap. tokenHash must already be hashed.
func (d *DB) CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error) {
	// Evict oldest sessions at or above the cap. A failed eviction must not
	// block login (the next CreateSession trims again, and a persistent failure
	// fails InsertSession anyway), but it must not be invisible.
	if err := d.q.EvictOldestSessions(ctx, dbgen.EvictOldestSessionsParams{
		UserID: userID,
		Offset: maxSessionsPerUser - 1,
	}); err != nil {
		slog.Warn("session cap: failed to evict oldest sessions",
			"user_id", userID, "err", err)
	}

	return insertSession(ctx, d.q, userID, tokenHash, device, ip, true)
}

// CreateFirstSession inserts an account's first session already seen, since
// there is no other device to tell, and needs no cap eviction.
func (d *DB) CreateFirstSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error) {
	return insertSession(ctx, d.q, userID, tokenHash, device, ip, false)
}

// insertSession inserts one session row through q (d.q, or d.q.WithTx(tx) when
// it must commit with other writes). unseen marks a new login the account has
// not acknowledged.
func insertSession(ctx context.Context, q *dbgen.Queries, userID int64, tokenHash, device, ip string, unseen bool) (int64, error) {
	expiresAt := time.Now().Add(sessionTTL).UTC().Format(dbtime.ISOLayout)
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
	return sessionRowID(res, err, userID)
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
	sess := sessionFromColumns(s.ID, s.UserID, s.Token, s.Device, s.IpAddress, s.CreatedAt, s.LastUsed, s.ExpiresAt, s.Unseen)
	return &sess, nil
}

// SessionWithBanStatus combines session data with user ban fields in one query.
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
		ID:         row.ID,
		UserID:     row.UserID,
		TokenHash:  row.Token,
		Device:     derefString(row.Device),
		IP:         derefString(row.IpAddress),
		CreatedAt:  row.CreatedAt,
		LastUsed:   row.LastUsed,
		ExpiresAt:  row.ExpiresAt,
		Banned:     row.Banned != 0,
		BanReason:  row.BanReason,
		BanExpires: row.BanExpires,
	}, nil
}

// GetSessionsWithBanStatusBatch returns session+ban rows for every token hash,
// keyed by hash; hashes with no session are absent. The ws revoked-session
// sweep uses it to cost one query instead of N.
func (d *DB) GetSessionsWithBanStatusBatch(ctx context.Context, tokenHashes []string) (map[string]*SessionWithBanStatus, error) {
	result := make(map[string]*SessionWithBanStatus, len(tokenHashes))
	// Chunk the IN list far below SQLite's bound-parameter limit.
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

// DeleteOtherSessions removes all of the user's sessions except keepSessionID
// (after a password or 2FA change).
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

// DeleteExpiredSessions removes sessions whose expires_at is past. The
// comparison is plain text against idx_sessions_expires_at, so the cutoff must
// use dbtime.ISOLayout, the stored format; a space-separated cutoff would
// compare wrong (' ' sorts before 'T') and delete nothing.
func (d *DB) DeleteExpiredSessions(ctx context.Context) error {
	cutoff := time.Now().UTC().Format(dbtime.ISOLayout)
	if err := d.q.DeleteExpiredSessions(ctx, cutoff); err != nil {
		return fmt.Errorf("DeleteExpiredSessions: %w", err)
	}
	return nil
}

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
		s := expiresAt.UTC().Format(dbtime.ISOLayout)
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

// UseInviteAtomic validates and increments use_count in one statement,
// avoiding the TOCTOU race of GetInvite then UseInvite. The UPDATE matches
// only a code that exists, is not revoked, is within max_uses (NULL is
// unlimited) and is not expired; zero rows affected means missing, revoked,
// expired or exhausted, and returns an error.
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

// generateInviteCode produces a random 8-byte (16-char hex) code.
func generateInviteCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
