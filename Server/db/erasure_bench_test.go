package db_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// BenchmarkEraseAccount erases a member with n messages (plus the mentions,
// attachments, reactions and replay events seedBulkErasure hangs off them)
// from a file-backed WAL database and reports how the work was cut up:
//
//	chunks        drain transactions committed (the lock and finish stages are
//	              not counted)
//	max_chunk_ms  the longest any one stage held the writer, measured between
//	              consecutive commits (lock, every chunk, finish, checkpoint)
//
// The gate in docs/capacity.md is max_chunk_ms <= 250 at 100k. Run it with
//
//	go test -run '^$' -bench 'BenchmarkEraseAccount' -benchtime 1x ./db/
func BenchmarkEraseAccount(b *testing.B) {
	for _, tc := range []struct {
		name string
		n    int
	}{{"10k", 10_000}, {"100k", 100_000}} {
		b.Run(tc.name, func(b *testing.B) {
			ctx := context.Background()
			var chunks int
			var maxChunk time.Duration
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				database := openErasureFile(b, filepath.Join(b.TempDir(), "bench.sqlite"))
				subject, err := database.CreateUser(ctx, "bench-subject", "hash", 4)
				if err != nil {
					b.Fatalf("CreateUser: %v", err)
				}
				other, err := database.CreateUser(ctx, "bench-other", "hash", 2)
				if err != nil {
					b.Fatalf("CreateUser: %v", err)
				}
				channel, err := database.CreateChannel(ctx, "bench", "text", "", "", 0)
				if err != nil {
					b.Fatalf("CreateChannel: %v", err)
				}
				seedBulkErasure(b, database, subject, other, channel, tc.n)

				last := time.Now()
				chunks = 0
				db.SetErasureChunkHookForTest(database, func(stage string, _ int) error {
					now := time.Now()
					if stage == "chunk" {
						chunks++
					}
					if d := now.Sub(last); d > maxChunk {
						maxChunk = d
						if testing.Verbose() {
							b.Logf("slowest so far: %s #%d %s", stage, chunks, d)
						}
					}
					last = now
					return nil
				})
				b.StartTimer()
				if _, err := database.EraseAccount(ctx, subject, ""); err != nil {
					b.Fatalf("EraseAccount: %v", err)
				}
				b.StopTimer()
				var left int
				if err := database.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM users WHERE id = ?1) + (SELECT COUNT(*) FROM messages WHERE user_id = ?1)`, subject).Scan(&left); err != nil || left != 0 {
					b.Fatalf("rows left after the erasure = %d (%v)", left, err)
				}
				_ = database.Close()
				b.StartTimer()
			}
			b.ReportMetric(float64(chunks), "chunks")
			b.ReportMetric(float64(maxChunk.Microseconds())/1000, "max_chunk_ms")
		})
	}
}
