package db

import "context"

// FirstIDAtOrAfterForTest exposes the id-bound binary search to db_test.
func (d *DB) FirstIDAtOrAfterForTest(ctx context.Context, ts string) (int64, error) {
	return d.firstIDAtOrAfter(ctx, ts)
}
