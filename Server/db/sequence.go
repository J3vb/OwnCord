package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// SequenceValue returns table's AUTOINCREMENT counter — the largest id the
// table ever handed out, from sqlite_sequence — or 0 when the table has
// never had a row.
func (d *DB) SequenceValue(ctx context.Context, table string) (int64, error) {
	var seq int64
	err := d.reader.QueryRowContext(ctx, `SELECT seq FROM sqlite_sequence WHERE name = ?`, table).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("SequenceValue %s: %w", table, err)
	}
	return seq, nil
}

// RaiseSequences moves each named table's AUTOINCREMENT counter up to its
// floor when it stands below it, so the next insert takes an id above every
// floor; a counter already past its floor is left alone. The deletion
// markers record the floors when they are written
// (MarkerStore.RaiseSequenceFloor) and the erasure-markers start-up stage
// applies them before the markers are replayed, so a restore that rolled
// sqlite_sequence back with the rest of the file cannot hand an erased
// account's id — and with it the marker's token — to a new account (B4-10).
// sqlite_sequence accepts ordinary writes.
func (d *DB) RaiseSequences(ctx context.Context, floors map[string]int64) error {
	if len(floors) == 0 {
		return nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("RaiseSequences begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	for table, floor := range floors {
		if floor <= 0 {
			continue
		}
		res, err := tx.ExecContext(ctx, `UPDATE sqlite_sequence SET seq = ?1 WHERE name = ?2 AND seq < ?1`, floor, table)
		if err != nil {
			return fmt.Errorf("RaiseSequences %s: %w", table, err)
		}
		if n, err := res.RowsAffected(); err != nil {
			return fmt.Errorf("RaiseSequences %s rows: %w", table, err)
		} else if n == 1 {
			continue
		}
		// No row below the floor: either the counter is already past it, or
		// the table never had a row and has no counter yet — insert one so
		// the first insert lands above the floor too.
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO sqlite_sequence (name, seq) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?1)`,
			table, floor); err != nil {
			return fmt.Errorf("RaiseSequences %s insert: %w", table, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("RaiseSequences commit: %w", err)
	}
	return nil
}
