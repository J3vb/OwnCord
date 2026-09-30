//go:build !race && !deadlock

package ws_test

import (
	"fmt"
	"io"
	"testing"
)

// Skipped under -race, where the detector's instrumentation skews allocation
// counts, and under the deadlock tag, where syncutil.Mutex is the go-deadlock
// mutex whose Lock allocates.
//
// P5-O01: the member array is encoded once per member generation and every
// ready streams it to the socket, splicing in only what the viewer's presence
// rule decides. Before, each ready re-encoded the whole roster into a fresh
// buffer and copied it: about 130 KB allocated per ready over this 500-member
// roster, most of it the roster's JSON.
func TestWriteReady_AllocatesAFifthOfTheRoster(t *testing.T) {
	hub, database := newTestHub(t)
	const members = 500
	ids := make([]int64, members)
	for i := range members {
		ids[i] = seedOwnerUser(t, database, fmt.Sprintf("roster-%d", i)).ID
	}
	var failed error
	res := testing.Benchmark(func(b *testing.B) {
		b.ReportAllocs()
		for i := range b.N {
			if err := hub.WriteReadyForTest(database, ids[i%members], nil, io.Discard); err != nil {
				failed = err
			}
		}
	})
	if failed != nil {
		t.Fatalf("WriteReady: %v", failed)
	}
	// A fifth of the 130 KB the whole-roster encode allocated.
	const limit = 26 << 10
	if got := res.AllocedBytesPerOp(); got > limit {
		t.Errorf("one ready allocates %d bytes, want at most %d", got, limit)
	}
}
