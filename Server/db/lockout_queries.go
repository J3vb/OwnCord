package db

import (
	"context"
	"time"

	"github.com/owncord/server/db/dbgen"
)

// UpsertLockout inserts or replaces a rate-limit lockout entry.
func (d *DB) UpsertLockout(ctx context.Context, key string, expiresAt time.Time) error {
	return d.q.UpsertLockout(ctx, dbgen.UpsertLockoutParams{
		Key:       key,
		ExpiresAt: expiresAt.UTC().Format(time.RFC3339),
	})
}

// LoadActiveLockouts returns all lockouts that have not yet expired as
// parallel slices of keys and expiry times.
func (d *DB) LoadActiveLockouts(ctx context.Context) (keys []string, expiresAt []time.Time, err error) {
	rows, err := d.q.LoadActiveLockouts(ctx, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return nil, nil, err
	}
	for _, r := range rows {
		t, parseErr := time.Parse(time.RFC3339, r.ExpiresAt)
		if parseErr != nil {
			continue // skip unparseable rows
		}
		keys = append(keys, r.Key)
		expiresAt = append(expiresAt, t)
	}
	return keys, expiresAt, nil
}

// CleanupExpiredLockouts removes lockout rows whose expiry has passed.
func (d *DB) CleanupExpiredLockouts(ctx context.Context) error {
	return d.q.CleanupExpiredLockouts(ctx, time.Now().UTC().Format(time.RFC3339))
}

// DeleteLockout removes a single lockout entry.
func (d *DB) DeleteLockout(ctx context.Context, key string) error {
	return d.q.DeleteLockout(ctx, key)
}
