package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// reportMutation runs one guarded report write and, when it touched a row,
// appends the matching report_events row in the SAME writer transaction: the
// history can no longer lose a row to a failure, interleave with a racing
// mutation, or name an actor erased between the write and a separate insert.
// Zero rows rolls back and returns (false, nil).
func (d *DB) reportMutation(ctx context.Context, op string, reportID, actorID int64, action, detail string, mutate func(*dbgen.Queries) (int64, error)) (bool, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("%s begin tx: %w", op, err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := dbgen.New(tx)
	n, err := mutate(q)
	if err != nil {
		return false, fmt.Errorf("%s: %w", op, err)
	}
	if n != 1 {
		return false, nil
	}
	if err := q.InsertReportEvent(ctx, dbgen.InsertReportEventParams{ReportID: reportID, ActorID: actorID, Action: action, Detail: detail}); err != nil {
		return false, fmt.Errorf("%s event: %w", op, err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("%s commit: %w", op, err)
	}
	return true, nil
}
