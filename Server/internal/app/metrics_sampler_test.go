package app

import (
	"context"
	"database/sql"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/metrics"
)

// TestDBWaitCounters_NamesMatchWhatTheAPIReads pins the four counter names this
// package registers against what api.NewWindowMetrics reads back, with the unit
// conversion: a rename on either side would silently report zeros.
func TestDBWaitCounters_NamesMatchWhatTheAPIReads(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var writer, reader atomic.Pointer[sql.DBStats]
		writer.Store(&sql.DBStats{})
		reader.Store(&sql.DBStats{})
		w, err := metrics.NewWindows(metrics.WindowSpec{
			Tick:     10 * time.Second,
			Horizon:  time.Minute,
			Counters: dbWaitCounters(func() sql.DBStats { return *writer.Load() }, func() sql.DBStats { return *reader.Load() }),
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := w.Run(ctx)
		writer.Store(&sql.DBStats{WaitCount: 4, WaitDuration: 2500 * time.Millisecond})
		reader.Store(&sql.DBStats{WaitCount: 7, WaitDuration: 500 * time.Millisecond})
		time.Sleep(10 * time.Second)
		synctest.Wait()
		snap, ok := w.Snapshot(time.Minute)
		if !ok {
			t.Fatal("no snapshot after two samples")
		}
		cancel()
		<-done
		got := api.NewWindowMetrics(snap)
		if got.DBWriterWaitCount != 4 || got.DBWriterWaitSeconds != 2.5 ||
			got.DBReaderWaitCount != 7 || got.DBReaderWaitSeconds != 0.5 {
			t.Fatalf("api read %d/%v/%d/%v, want 4/2.5/7/0.5",
				got.DBWriterWaitCount, got.DBWriterWaitSeconds, got.DBReaderWaitCount, got.DBReaderWaitSeconds)
		}
	})
}

// A negative int64 from the pool stats clamps to zero instead of wrapping to a
// huge uint64.
func TestPoolWait_ClampsNegativeStats(t *testing.T) {
	neg := func() sql.DBStats { return sql.DBStats{WaitCount: -3, WaitDuration: -time.Second} }
	for _, c := range poolWait("count", "nanos", neg) {
		if got := c.Read(); got != 0 {
			t.Errorf("%s = %d, want 0", c.Name, got)
		}
	}
}
