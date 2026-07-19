package db

import (
	"time"

	"github.com/owncord/server/db/dbgen"
)

// UpsertLockout inserts or replaces a rate-limit lockout entry.
func (d *DB) UpsertLockout(key string, expiresAt time.Time) error {
	return d.q.UpsertLockout(dbCtx(), dbgen.UpsertLockoutParams{
		Key:       key,
		ExpiresAt: expiresAt.UTC().Format(time.RFC3339),
	})
}

// LoadActiveLockouts returns all lockouts that have not yet expired as
// parallel slices of keys and expiry times.
func (d *DB) LoadActiveLockouts() (keys []string, expiresAt []time.Time, err error) {
	rows, err := d.q.LoadActiveLockouts(dbCtx(), time.Now().UTC().Format(time.RFC3339))
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
func (d *DB) CleanupExpiredLockouts() error {
	return d.q.CleanupExpiredLockouts(dbCtx(), time.Now().UTC().Format(time.RFC3339))
}

// DeleteLockout removes a single lockout entry.
func (d *DB) DeleteLockout(key string) error {
	return d.q.DeleteLockout(dbCtx(), key)
}
