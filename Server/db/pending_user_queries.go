package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ErrPendingQueueFull is CreatePendingUser refusing because the approval queue holds
// maxPending rows.
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

// ApprovePendingUser unlocks an application; ErrNotFound when the id is not pending.
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

// DenyPendingUser anonymises an application (username released as "[denied-{id}]",
// password and profile cleared) and locks it as 'denied' for good, because audit rows
// reference the id. Only a still-pending row is touched; ErrNotFound otherwise.
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
