package db

import "time"

// UpsertLockout inserts or replaces a rate-limit lockout entry.
func (d *DB) UpsertLockout(key string, expiresAt time.Time) error {
	_, err := d.sqlDB.Exec(
		`INSERT OR REPLACE INTO rate_lockouts (key, expires_at) VALUES (?, ?)`,
		key, expiresAt.UTC().Format(time.RFC3339),
	)
	return err
}

// LoadActiveLockouts returns all lockouts that have not yet expired as
// parallel slices of keys and expiry times.
func (d *DB) LoadActiveLockouts() (keys []string, expiresAt []time.Time, err error) {
	rows, err := d.sqlDB.Query(
		`SELECT key, expires_at FROM rate_lockouts WHERE expires_at > ?`,
		time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close() //nolint:errcheck

	for rows.Next() {
		var key, expiresStr string
		if err := rows.Scan(&key, &expiresStr); err != nil {
			return nil, nil, err
		}
		t, parseErr := time.Parse(time.RFC3339, expiresStr)
		if parseErr != nil {
			continue // skip unparseable rows
		}
		keys = append(keys, key)
		expiresAt = append(expiresAt, t)
	}
	return keys, expiresAt, rows.Err()
}

// CleanupExpiredLockouts removes lockout rows whose expiry has passed.
func (d *DB) CleanupExpiredLockouts() error {
	_, err := d.sqlDB.Exec(
		`DELETE FROM rate_lockouts WHERE expires_at <= ?`,
		time.Now().UTC().Format(time.RFC3339),
	)
	return err
}

// DeleteLockout removes a single lockout entry.
func (d *DB) DeleteLockout(key string) error {
	_, err := d.sqlDB.Exec(`DELETE FROM rate_lockouts WHERE key = ?`, key)
	return err
}
