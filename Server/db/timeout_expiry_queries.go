package db

import (
	"context"
	"fmt"
	"time"
)

// ActiveTimeoutExpiry is one unlifted, unexpired timeout's target and expiry.
type ActiveTimeoutExpiry struct {
	UserID    int64
	ExpiresAt time.Time
}

// ListActiveTimeoutExpiries lists every active timeout's target and expiry,
// for the hub to re-arm its expiry refreshes at startup.
func (d *DB) ListActiveTimeoutExpiries(ctx context.Context) ([]ActiveTimeoutExpiry, error) {
	rows, err := d.q.ListActiveTimeoutExpiries(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListActiveTimeoutExpiries: %w", err)
	}
	out := make([]ActiveTimeoutExpiry, 0, len(rows))
	for _, r := range rows {
		if r.ExpiresAt == nil {
			continue
		}
		out = append(out, ActiveTimeoutExpiry{UserID: r.TargetID, ExpiresAt: parseSQLiteTime(*r.ExpiresAt)})
	}
	return out, nil
}
