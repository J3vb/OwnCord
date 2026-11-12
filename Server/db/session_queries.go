package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// maxSessionsPerUser caps concurrent sessions per user, evicting the oldest, to bound
// accumulation from credential stuffing or token theft.
const maxSessionsPerUser = 25

// CreateSession inserts a session, evicting the oldest at the cap; tokenHash must be hashed.
func (d *DB) CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error) {
	if err := d.q.EvictOldestSessions(ctx, dbgen.EvictOldestSessionsParams{
		UserID: userID,
		Offset: maxSessionsPerUser - 1,
	}); err != nil {
		slog.Warn("session cap: failed to evict oldest sessions",
			"user_id", userID, "err", err)
	}

	return insertSession(ctx, d.q, userID, tokenHash, device, ip, true)
}

// CreateFirstSession inserts an account's first session already seen, with no cap eviction.
func (d *DB) CreateFirstSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error) {
	return insertSession(ctx, d.q, userID, tokenHash, device, ip, false)
}

// insertSession inserts one session row through q; unseen marks a new login the
// account has not acknowledged.
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

// GetSessionByTokenHash retrieves a session by its hashed token, or nil if not found.
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

// GetSessionWithBanStatus returns the session joined with the user's ban status; nil,
// nil when not found.
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

// GetSessionsWithBanStatusBatch returns session+ban rows by token hash (unknown hashes
// absent), one query for the ws revoked-session sweep.
func (d *DB) GetSessionsWithBanStatusBatch(ctx context.Context, tokenHashes []string) (map[string]*SessionWithBanStatus, error) {
	result := make(map[string]*SessionWithBanStatus, len(tokenHashes))
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

// DeleteOtherSessions removes all of the user's sessions except keepSessionID (after a password or
// 2FA change).
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

// DeleteExpiredSessions removes sessions whose expires_at is past. The cutoff must use
// dbtime.ISOLayout so idx_sessions_expires_at compares right: a space-separated cutoff
// would delete nothing (' ' < 'T').
func (d *DB) DeleteExpiredSessions(ctx context.Context) error {
	cutoff := time.Now().UTC().Format(dbtime.ISOLayout)
	if err := d.q.DeleteExpiredSessions(ctx, cutoff); err != nil {
		return fmt.Errorf("DeleteExpiredSessions: %w", err)
	}
	return nil
}
