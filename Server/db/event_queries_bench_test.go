package db_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// BenchmarkPersistEvents measures the writer-held time of one events-table
// flush (WP 4.6a): a file-backed WAL database, one PersistEvents transaction
// per iteration, batch rows each. ns/op is the cost of one flush; multiplied by
// event_persister.flushes it gives the writer share the replay tier costs.
// It is reported, not gated, and changes no behaviour.
func BenchmarkPersistEvents(b *testing.B) {
	for _, batch := range []int{1, 50} {
		b.Run(fmt.Sprintf("batch=%d", batch), func(b *testing.B) {
			database, err := db.Open(filepath.Join(b.TempDir(), "bench.db"))
			if err != nil {
				b.Fatalf("db.Open: %v", err)
			}
			b.Cleanup(func() { _ = database.Close() })
			if err := db.Migrate(database); err != nil {
				b.Fatalf("db.Migrate: %v", err)
			}

			ctx := context.Background()
			payload := []byte(`{"type":"chat_message","payload":{"channel_id":1,"content":"benchmark payload of typical size"}}`)
			events := make([]db.PersistedEvent, batch)
			seq := int64(0)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				for i := range events {
					seq++
					events[i] = db.PersistedEvent{Seq: seq, EventType: "chat_message", ChannelID: 1, Payload: payload}
				}
				if n, err := database.PersistEvents(ctx, events); err != nil || n != batch {
					b.Fatalf("PersistEvents = %d rows, err %v; want %d", n, err, batch)
				}
			}
			b.StopTimer()
			b.ReportMetric(float64(batch)*float64(b.N)/b.Elapsed().Seconds(), "rows/s")
		})
	}
}
