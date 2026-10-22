package db

import "context"

// FirstIDAtOrAfterForTest exposes the id-bound binary search to db_test.
func (d *DB) FirstIDAtOrAfterForTest(ctx context.Context, ts string) (int64, error) {
	return d.firstIDAtOrAfter(ctx, ts)
}

// SetRankCandidateCapForTest lowers the relevance candidate cap and returns a
// function that restores it.
func SetRankCandidateCapForTest(n int) (restore func()) {
	old := rankCandidateCap
	rankCandidateCap = n
	return func() { rankCandidateCap = old }
}
