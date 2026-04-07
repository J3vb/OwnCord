package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/owncord/server/db"
)

// ── EventStore (Phase B Step 7) ─────────────────────────────────────────────

// PersistEvent appends a single event to the events table with the
// caller-supplied seq. The hub assigns seq before this is called so the row
// seq always matches the wrapped-payload seq, even if the persister drops
// some events under load.
func (s *SQLiteStore) PersistEvent(ctx context.Context, seq int64, eventType string, channelID int64, payload []byte) error {
	_, err := s.db.SQLDb().ExecContext(ctx,
		`INSERT INTO events (seq, event_type, channel_id, payload) VALUES (?, ?, ?, ?)`,
		seq, eventType, channelID, payload,
	)
	if err != nil {
		return fmt.Errorf("PersistEvent: %w", err)
	}
	return nil
}

// GetEventsSince returns events with seq > afterSeq up to limit, ordered ASC.
func (s *SQLiteStore) GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error) {
	rows, err := s.db.SQLDb().QueryContext(ctx,
		`SELECT seq, event_type, channel_id, payload, created_at
		   FROM events
		  WHERE seq > ?
		  ORDER BY seq ASC
		  LIMIT ?`,
		afterSeq, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("GetEventsSince: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanEventRows(rows)
}

// GetEventsSinceForChannels filters events to those whose channel_id is 0
// (global broadcast) or in channelIDs.
func (s *SQLiteStore) GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error) {
	// Build IN clause manually since database/sql does not expand slices.
	if len(channelIDs) == 0 {
		// Only global broadcasts.
		rows, err := s.db.SQLDb().QueryContext(ctx,
			`SELECT seq, event_type, channel_id, payload, created_at
			   FROM events
			  WHERE seq > ? AND channel_id = 0
			  ORDER BY seq ASC
			  LIMIT ?`,
			afterSeq, limit,
		)
		if err != nil {
			return nil, fmt.Errorf("GetEventsSinceForChannels (global only): %w", err)
		}
		defer func() { _ = rows.Close() }()
		return scanEventRows(rows)
	}

	placeholders := make([]string, len(channelIDs))
	args := make([]any, 0, len(channelIDs)+2)
	args = append(args, afterSeq)
	for i, cid := range channelIDs {
		placeholders[i] = "?"
		args = append(args, cid)
	}
	args = append(args, limit)

	query := fmt.Sprintf(
		`SELECT seq, event_type, channel_id, payload, created_at
		   FROM events
		  WHERE seq > ?
		    AND (channel_id = 0 OR channel_id IN (%s))
		  ORDER BY seq ASC
		  LIMIT ?`,
		strings.Join(placeholders, ","),
	)
	rows, err := s.db.SQLDb().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("GetEventsSinceForChannels: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanEventRows(rows)
}

// GetMaxEventSeq returns the largest seq in the events table, or 0 if empty.
func (s *SQLiteStore) GetMaxEventSeq(ctx context.Context) (int64, error) {
	var maxSeq sql.NullInt64
	err := s.db.SQLDb().QueryRowContext(ctx, `SELECT MAX(seq) FROM events`).Scan(&maxSeq)
	if err != nil {
		return 0, fmt.Errorf("GetMaxEventSeq: %w", err)
	}
	if !maxSeq.Valid {
		return 0, nil
	}
	return maxSeq.Int64, nil
}

// PruneEventsOlderThan deletes events older than cutoff. Returns rows deleted.
func (s *SQLiteStore) PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := s.db.SQLDb().ExecContext(ctx,
		`DELETE FROM events WHERE created_at < ?`,
		cutoff.UTC().Format("2006-01-02 15:04:05"),
	)
	if err != nil {
		return 0, fmt.Errorf("PruneEventsOlderThan: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("PruneEventsOlderThan RowsAffected: %w", err)
	}
	return n, nil
}

// ── PluginStore (Phase C Step 9) ────────────────────────────────────────────

func (s *SQLiteStore) InstallPlugin(ctx context.Context, name, version, manifestJSON string) (int64, error) {
	res, err := s.db.SQLDb().ExecContext(ctx,
		`INSERT INTO plugins (name, version, enabled, manifest_json) VALUES (?, ?, 0, ?)
		 ON CONFLICT(name) DO UPDATE SET version = excluded.version, manifest_json = excluded.manifest_json`,
		name, version, manifestJSON,
	)
	if err != nil {
		return 0, fmt.Errorf("InstallPlugin: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil || id == 0 {
		// On conflict path LastInsertId may be 0; look up by name.
		row := s.db.SQLDb().QueryRowContext(ctx, `SELECT id FROM plugins WHERE name = ?`, name)
		if scanErr := row.Scan(&id); scanErr != nil {
			return 0, fmt.Errorf("InstallPlugin lookup: %w", scanErr)
		}
	}
	return id, nil
}

func (s *SQLiteStore) EnablePlugin(ctx context.Context, id int64) error {
	_, err := s.db.SQLDb().ExecContext(ctx, `UPDATE plugins SET enabled = 1 WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) DisablePlugin(ctx context.Context, id int64) error {
	_, err := s.db.SQLDb().ExecContext(ctx, `UPDATE plugins SET enabled = 0 WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) UninstallPlugin(ctx context.Context, id int64) error {
	_, err := s.db.SQLDb().ExecContext(ctx, `DELETE FROM plugins WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) GetPlugin(ctx context.Context, id int64) (*db.PluginRow, error) {
	row := s.db.SQLDb().QueryRowContext(ctx,
		`SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins WHERE id = ?`,
		id,
	)
	return scanPluginRow(row)
}

func (s *SQLiteStore) GetPluginByName(ctx context.Context, name string) (*db.PluginRow, error) {
	row := s.db.SQLDb().QueryRowContext(ctx,
		`SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins WHERE name = ?`,
		name,
	)
	return scanPluginRow(row)
}

func (s *SQLiteStore) ListPlugins(ctx context.Context) ([]db.PluginRow, error) {
	rows, err := s.db.SQLDb().QueryContext(ctx,
		`SELECT id, name, version, enabled, manifest_json, installed_at FROM plugins ORDER BY name`,
	)
	if err != nil {
		return nil, fmt.Errorf("ListPlugins: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []db.PluginRow
	for rows.Next() {
		var p db.PluginRow
		var enabledInt int64
		var installedAt string
		if err := rows.Scan(&p.ID, &p.Name, &p.Version, &enabledInt, &p.ManifestJSON, &installedAt); err != nil {
			return nil, fmt.Errorf("ListPlugins scan: %w", err)
		}
		p.Enabled = enabledInt != 0
		p.InstalledAt = parseSQLiteTime(installedAt)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) PluginKVGet(ctx context.Context, pluginID int64, key string) ([]byte, error) {
	row := s.db.SQLDb().QueryRowContext(ctx,
		`SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?`,
		pluginID, key,
	)
	var v []byte
	if err := row.Scan(&v); err != nil {
		return nil, err
	}
	return v, nil
}

func (s *SQLiteStore) PluginKVSet(ctx context.Context, pluginID int64, key string, value []byte) error {
	_, err := s.db.SQLDb().ExecContext(ctx,
		`INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
		pluginID, key, value,
	)
	return err
}

func (s *SQLiteStore) PluginKVDelete(ctx context.Context, pluginID int64, key string) error {
	_, err := s.db.SQLDb().ExecContext(ctx,
		`DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?`,
		pluginID, key,
	)
	return err
}

func (s *SQLiteStore) PluginKVScan(ctx context.Context, pluginID int64, prefix string, limit int) (map[string][]byte, error) {
	rows, err := s.db.SQLDb().QueryContext(ctx,
		`SELECT key, value FROM plugin_kv WHERE plugin_id = ? AND key LIKE ? ORDER BY key LIMIT ?`,
		pluginID, prefix+"%", limit,
	)
	if err != nil {
		return nil, fmt.Errorf("PluginKVScan: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make(map[string][]byte)
	for rows.Next() {
		var k string
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// ── helpers ─────────────────────────────────────────────────────────────────

type rowScanner interface {
	Scan(dest ...any) error
}

func scanPluginRow(row rowScanner) (*db.PluginRow, error) {
	var p db.PluginRow
	var enabledInt int64
	var installedAt string
	if err := row.Scan(&p.ID, &p.Name, &p.Version, &enabledInt, &p.ManifestJSON, &installedAt); err != nil {
		return nil, err
	}
	p.Enabled = enabledInt != 0
	p.InstalledAt = parseSQLiteTime(installedAt)
	return &p, nil
}

type rowsScanner interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanEventRows(rows rowsScanner) ([]db.PersistedEvent, error) {
	var out []db.PersistedEvent
	for rows.Next() {
		var e db.PersistedEvent
		var createdAt string
		if err := rows.Scan(&e.Seq, &e.EventType, &e.ChannelID, &e.Payload, &createdAt); err != nil {
			return nil, fmt.Errorf("scanEventRows: %w", err)
		}
		e.CreatedAt = parseSQLiteTime(createdAt)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func parseSQLiteTime(s string) time.Time {
	// SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" in UTC.
	for _, layout := range []string{
		"2006-01-02 15:04:05",
		time.RFC3339,
		time.RFC3339Nano,
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}
