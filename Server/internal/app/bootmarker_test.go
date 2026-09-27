package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestBootMarker_RecordsStartAndCleanShutdown pins the marker's own contract
// (SRE-08): a first boot has no record, a boot writes a running marker, and a
// clean close rewrites it so the next boot reads "clean".
func TestBootMarker_RecordsStartAndCleanShutdown(t *testing.T) {
	path := filepath.Join(t.TempDir(), bootMarkerRelPath)

	// First boot: nothing on disk yet.
	if st := readBootMarker(path); st.Recorded {
		t.Fatalf("first boot read a marker: %+v", st)
	}

	started := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	marker, err := openBootMarker(path, started)
	if err != nil {
		t.Fatalf("openBootMarker: %v", err)
	}

	// A run in progress reads back as unclean: the marker is still armed.
	st := readBootMarker(path)
	if !st.Recorded || !st.Unclean || !st.StartedAt.Equal(started) {
		t.Fatalf("running marker read back as %+v, want recorded+unclean+started", st)
	}

	// A panic is recorded against the running marker.
	panicked := started.Add(90 * time.Minute)
	marker.recordPanic(panicked)
	if st := readBootMarker(path); !st.LastPanicAt.Equal(panicked) {
		t.Fatalf("last panic = %v, want %v", st.LastPanicAt, panicked)
	}

	// A clean shutdown clears the unclean flag but keeps the record.
	if err := marker.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	st = readBootMarker(path)
	if !st.Recorded || st.Unclean {
		t.Fatalf("after a clean close: %+v, want recorded and clean", st)
	}
	if !st.LastPanicAt.Equal(panicked) {
		t.Fatalf("clean marker lost the panic time: %v", st.LastPanicAt)
	}
}

// TestBootMarker_CorruptFileIsNotClean pins that a torn marker is treated as
// unclean, not silently as a clean exit: an unreadable record is missing
// evidence, and reporting "clean" would hide the crash that tore it.
func TestBootMarker_CorruptFileIsNotClean(t *testing.T) {
	path := filepath.Join(t.TempDir(), bootMarkerRelPath)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	st := readBootMarker(path)
	if !st.Recorded || !st.Unclean {
		t.Fatalf("corrupt marker read as %+v, want recorded+unclean", st)
	}
}

// TestBootMarker_MissingFileIsUnknown pins that a missing marker file (a
// first start) reads as not recorded, so the panel reports unknown.
func TestBootMarker_MissingFileIsUnknown(t *testing.T) {
	if st := readBootMarker(filepath.Join(t.TempDir(), bootMarkerRelPath)); st.Recorded {
		t.Fatalf("a missing marker read as recorded: %+v", st)
	}
}
