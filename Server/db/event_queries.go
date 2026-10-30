package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/dbtime"
)

// PersistEvent appends one event with the caller-supplied seq. The hub assigns
// seq beforehand so the row seq always matches the wrapped-payload seq, even if
// the persister drops events under load.
func (d *DB) PersistEvent(ctx context.Context, seq int64, eventType string, channelID int64, payload []byte) error {
	_, err := d.writer.ExecContext(ctx,
		`INSERT INTO events (seq, event_type, channel_id, payload) VALUES (?, ?, ?, ?)`,
		seq, eventType, channelID, payload,
	)
	if err != nil {
		return fmt.Errorf("PersistEvent: %w", err)
	}
	return nil
}

// PersistEvents appends a batch in one transaction with one prepared insert, so
// the persister's flush costs one fsync instead of one per event. CreatedAt on
// the input is ignored (the column defaults). Best effort: if the batch fails
// (e.g. a duplicate seq) it falls back to per-row inserts so the good rows
// land. It returns the rows persisted and, if any was lost, the first per-row
// error.
func (d *DB) PersistEvents(ctx context.Context, events []PersistedEvent) (int, error) {
	if len(events) == 0 {
		return 0, nil
	}
	if err := d.persistEventsTx(ctx, events); err == nil {
		return len(events), nil
	}
	// Fallback: insert rows individually so one bad row does not drop the batch.
	persisted := 0
	var firstErr error
	for _, e := range events {
		if err := d.PersistEvent(ctx, e.Seq, e.EventType, e.ChannelID, e.Payload); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		persisted++
	}
	return persisted, firstErr
}

// persistEventsTx inserts all events inside one transaction; any failure
// rolls the whole batch back.
func (d *DB) persistEventsTx(ctx context.Context, events []PersistedEvent) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("PersistEvents begin tx: %w", err)
	}
	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO events (seq, event_type, channel_id, payload) VALUES (?, ?, ?, ?)`,
	)
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("PersistEvents prepare: %w", err)
	}
	defer func() { _ = stmt.Close() }()
	for _, e := range events {
		if _, err := stmt.ExecContext(ctx, e.Seq, e.EventType, e.ChannelID, e.Payload); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("PersistEvents insert seq %d: %w", e.Seq, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("PersistEvents commit: %w", err)
	}
	return nil
}

// GetEventsSince returns events with seq > afterSeq up to limit, ordered ASC.
func (d *DB) GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]PersistedEvent, error) {
	rows, err := d.reader.QueryContext(ctx,
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
	// IN clause is built manually since database/sql does not expand slices.
	if len(channelIDs) == 0 {
		// Only global broadcasts.
		rows, err := d.reader.QueryContext(ctx,
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
	rows, err := d.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("GetEventsSinceForChannels: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return scanEventRows(rows)
}

// CountEventsInRange returns the unfiltered (all channels) count of events with
// afterSeq < seq <= uptoSeq. seq is the primary key, so the count can only fall
// short of (uptoSeq - afterSeq); callers use that to detect an interior gap
// left by a lost row without enumerating every seq.
func (d *DB) CountEventsInRange(ctx context.Context, afterSeq, uptoSeq int64) (int64, error) {
	var count int64
	err := d.reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM events WHERE seq > ? AND seq <= ?`,
		afterSeq, uptoSeq,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("CountEventsInRange: %w", err)
	}
	return count, nil
}

// GetMaxEventSeq returns the largest seq in the events table, or 0 if empty.
func (d *DB) GetMaxEventSeq(ctx context.Context) (int64, error) {
	var maxSeq sql.NullInt64
	err := d.reader.QueryRowContext(ctx, `SELECT MAX(seq) FROM events`).Scan(&maxSeq)
	if err != nil {
		return 0, fmt.Errorf("GetMaxEventSeq: %w", err)
	}
	if !maxSeq.Valid {
		return 0, nil
	}
	return maxSeq.Int64, nil
}

// pruneBatchSize bounds each DELETE's work. The pruner deletes in chunks so,
// with a day's frames at 10^5-10^6 rows, no single statement holds the sole
// writer connection for a noticeable stretch.
const pruneBatchSize = 5000

// eventPruneStatementHookForTest runs once per DELETE the prune loop issues, so
// the batching test can count statements without a driver trace. Test-only.
var eventPruneStatementHookForTest func()

// PruneEventsOlderThan deletes events older than cutoff in bounded chunks of
// pruneBatchSize rows, yielding the writer connection between statements.
// Returns the total rows deleted.
func (d *DB) PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error) {
	cutoffStr := cutoff.UTC().Format(dbtime.SQLiteLayout)
	var total int64
	for {
		if eventPruneStatementHookForTest != nil {
			eventPruneStatementHookForTest()
		}
		// seq is the INTEGER PRIMARY KEY (the rowid), so the subquery bounds
		// each statement to pruneBatchSize rows via idx_events_created_at.
		res, err := d.writer.ExecContext(ctx,
			`DELETE FROM events WHERE seq IN (
			     SELECT seq FROM events WHERE created_at < ? LIMIT ?
			 )`,
			cutoffStr, pruneBatchSize,
		)
		if err != nil {
			return total, fmt.Errorf("PruneEventsOlderThan: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return total, fmt.Errorf("PruneEventsOlderThan RowsAffected: %w", err)
		}
		total += n
		if n < pruneBatchSize {
			return total, nil
		}
	}
}

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
		dbtime.SQLiteLayout,
		time.RFC3339,
		time.RFC3339Nano,
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}
