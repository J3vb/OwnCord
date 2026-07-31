//go:build !race && !deadlock

package admin

import "testing"

// TestRingBuffer_WriteDoesNotAllocate locks in the point of the true-ring
// rewrite: a full buffer's Write is a slot overwrite, not a fresh
// capacity-sized slice + copy per log line. Skipped under -race, where the
// detector's instrumentation skews AllocsPerRun, and under the deadlock tag,
// where syncutil.Mutex is the go-deadlock mutex whose Lock allocates.
func TestRingBuffer_WriteDoesNotAllocate(t *testing.T) {
	buf := NewRingBuffer(64)
	entry := LogEntry{Timestamp: "2026-07-31T00:00:00Z", Level: "INFO", Message: "steady state"}
	// Fill past capacity so every measured Write overwrites the oldest slot.
	for range 128 {
		buf.Write(entry)
	}

	if allocs := testing.AllocsPerRun(1000, func() { buf.Write(entry) }); allocs != 0 {
		t.Errorf("Write allocates %.1f objects per call at steady state, want 0", allocs)
	}
}
