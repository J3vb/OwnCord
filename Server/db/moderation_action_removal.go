package db

import (
	"context"
	"fmt"
)

// RecordRemovalAction writes one removal ledger row targeting targetID, in its own
// transaction: a ban purge records its removal after the batches have committed. The
// actor guard is recordLedgerRow's.
func (d *DB) RecordRemovalAction(ctx context.Context, targetID, actorID int64, reason string) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("RecordRemovalAction begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if err := recordLedgerRow(ctx, tx, "removal", targetID, actorID, nil, reason); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("RecordRemovalAction commit: %w", err)
	}
	return nil
}
