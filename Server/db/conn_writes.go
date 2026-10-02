package db

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// The connection writes: the batched session touch and status stamps the
// service layer's ConnWrites flushes (P5-S07). Each batch is one writer
// transaction however many rows it covers.

// StampConnections applies a batch of connection stamps in one transaction:
// connected users come online unless they chose idle/dnd/invisible, and
// disconnected users fall back from "online" to "offline" while a chosen
// status is preserved for the next connect to honour. Both refresh last_seen.
// A user appears in at most one list; the caller keeps the latest stamp.
func (d *DB) StampConnections(ctx context.Context, connected, disconnected []int64) error {
	return d.inWriteTx(ctx, "StampConnections", func(q *dbgen.Queries) error {
		for ids := range slices.Chunk(connected, maxBatchIDs) {
			if err := q.StampUsersConnected(ctx, ids); err != nil {
				return err
			}
		}
		for ids := range slices.Chunk(disconnected, maxBatchIDs) {
			if err := q.StampUsersDisconnected(ctx, ids); err != nil {
				return err
			}
		}
		return nil
	})
}

// TouchSessions records a use of each named session: it updates last_used and
// slides expires_at to sessionTTL from now, capped at a year from sign-in
// (DP-05), in one transaction. A session that has already expired is left
// alone, so a touch never revives it. Expiry is judged at the flush, not at
// the use it records: a session used in the last minute before its idle
// expiry can lapse before the flush slides it, signing the user out.
func (d *DB) TouchSessions(ctx context.Context, tokenHashes []string) error {
	now := time.Now().UTC()
	return d.inWriteTx(ctx, "TouchSessions", func(q *dbgen.Queries) error {
		for tokens := range slices.Chunk(tokenHashes, maxBatchIDs) {
			if err := q.TouchSessions(ctx, dbgen.TouchSessionsParams{
				ExpiresAt: now.Add(sessionTTL).Format(sessionTimeLayout),
				Tokens:    tokens,
				Now:       now.Format(sessionTimeLayout),
			}); err != nil {
				return err
			}
		}
		return nil
	})
}

// maxBatchIDs bounds the IN list of one batched statement, well under
// SQLite's host-parameter limit.
const maxBatchIDs = 1000

// inWriteTx runs fn against the writer in one transaction, so a batch costs
// one commit however many statements it needs.
func (d *DB) inWriteTx(ctx context.Context, op string, fn func(q *dbgen.Queries) error) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("%s begin: %w", op, err)
	}
	if err := fn(d.q.WithTx(tx)); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("%s: %w", op, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%s commit: %w", op, err)
	}
	return nil
}
