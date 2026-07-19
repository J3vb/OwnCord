package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// ── Event persistence (Phase B Step 7) ──────────────────────────────────────
//
// These methods back the cold-tier reconnect replay. They were previously in
// the store package's SQLiteStore; they moved here (D3) when that pass-through
// layer was removed. The SQL is unchanged.

// PersistEvent appends a single event to the events table with the
// caller-supplied seq. The hub assigns seq before this is called so the row
// seq always matches the wrapped-payload seq, even if the persister drops
// some events under load.
func (d *DB) PersistEvent(ctx context.Context, seq int64, eventType string, channelID int64, payload []byte) error {
	_, err := d.sqlDB.ExecContext(ctx,
		`INSERT INTO events (seq, event_type, channel_id, payload) VALUES (?, ?, ?, ?)`,
		seq, eventType, channelID, payload,
	)
	if err != nil {
		return fmt.Errorf("PersistEvent: %w", err)
	}
	return nil
}

// GetEventsSince returns events with seq > afterSeq up to limit, ordered ASC.
func (d *DB) GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]PersistedEvent, error) {
	rows, err := d.sqlDB.QueryContext(ctx,
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
func (d *DB) GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]PersistedEvent, error) {
	// Build IN clause manually since database/sql does not expand slices.
	if len(channelIDs) == 0 {
		// Only global broadcasts.
		rows, err := d.sqlDB.QueryContext(ctx,
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

	query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
		`SELECT seq, event_type, channel_id, payload, created_at
		   FROM events
		  WHERE seq > ?
		    AND (channel_id = 0 OR channel_id IN (%s))
		  ORDER BY seq ASC
		  LIMIT ?`,
		strings.Join(placeholders, ","),
	)
	rows, err := d.sqlDB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("GetEventsSinceForChannels: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanEventRows(rows)
}

// GetMaxEventSeq returns the largest seq in the events table, or 0 if empty.
func (d *DB) GetMaxEventSeq(ctx context.Context) (int64, error) {
	var maxSeq sql.NullInt64
	err := d.sqlDB.QueryRowContext(ctx, `SELECT MAX(seq) FROM events`).Scan(&maxSeq)
	if err != nil {
		return 0, fmt.Errorf("GetMaxEventSeq: %w", err)
	}
	if !maxSeq.Valid {
		return 0, nil
	}
	return maxSeq.Int64, nil
}

// PruneEventsOlderThan deletes events older than cutoff. Returns rows deleted.
func (d *DB) PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := d.sqlDB.ExecContext(ctx,
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

// ── helpers ─────────────────────────────────────────────────────────────────

type rowsScanner interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanEventRows(rows rowsScanner) ([]PersistedEvent, error) {
	var out []PersistedEvent
	for rows.Next() {
		var e PersistedEvent
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

// parseSQLiteTime parses the several timestamp formats SQLite may return.
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
