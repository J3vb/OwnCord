package db

// reader_pool_test.go — P5-S08 pins the reader-pool sizing added for the
// 2,000-online target. The reader pool exists so concurrent reads do not queue
// behind the single writer, and its size is database.max_readers when set, or
// max(8, 2×NumCPU) when unset (clamped to 1–64 when explicit). The writer must
// stay at a single connection.

import (
	"path/filepath"
	"runtime"
	"testing"
)

// TestDefaultReaderConns_DoublesCPUWithFloorOfEight pins the automatic size:
// max(8, 2×CPU), so a two-core host gets 8 rather than the old 4, and a
// many-core host is still held to the documented 64 cap.
func TestDefaultReaderConns_DoublesCPUWithFloorOfEight(t *testing.T) {
	for _, tc := range []struct{ cpus, want int }{
		{1, 8},
		{2, 8},
		{4, 8},
		{8, 16},
		{16, 32},
		{40, 64},
	} {
		if got := defaultReaderConns(tc.cpus); got != tc.want {
			t.Errorf("defaultReaderConns(%d) = %d, want %d", tc.cpus, got, tc.want)
		}
	}
}

// TestOpenWithMaxReaders_HonoursExplicitClampAndDefault opens a real
// file-backed database for each case and reads the pool bound back off the
// handle. Zero (unset) follows the automatic size; an explicit value is
// honoured up to the 64 clamp. The writer stays pinned at one connection.
func TestOpenWithMaxReaders_HonoursExplicitClampAndDefault(t *testing.T) {
	for _, tc := range []struct{ maxReaders, want int }{
		{0, defaultReaderConns(runtime.NumCPU())},
		{1, 1},
		{5, 5},
		{64, 64},
		{200, 64},
	} {
		path := filepath.Join(t.TempDir(), "readers.db")
		d, err := OpenWithMaxReaders(path, tc.maxReaders)
		if err != nil {
			t.Fatalf("OpenWithMaxReaders(%d): %v", tc.maxReaders, err)
		}
		gotReader := d.SQLReaderDB().Stats().MaxOpenConnections
		gotWriter := d.SQLDb().Stats().MaxOpenConnections
		_ = d.Close()

		if gotReader != tc.want {
			t.Errorf("OpenWithMaxReaders(%d) reader MaxOpenConnections = %d, want %d",
				tc.maxReaders, gotReader, tc.want)
		}
		if gotWriter != 1 {
			t.Errorf("OpenWithMaxReaders(%d) writer MaxOpenConnections = %d, want 1 (single-writer invariant)",
				tc.maxReaders, gotWriter)
		}
	}
}
