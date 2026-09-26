package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

// execOnMarkerFile runs a statement against a closed marker file directly,
// standing in for the operator with sqlite3 — and, below, for the state a
// marker file written before the fingerprint existed is in.
func execOnMarkerFile(t *testing.T, path, stmt string) {
	t.Helper()
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer raw.Close() //nolint:errcheck
	if _, err := raw.Exec(stmt); err != nil {
		t.Fatalf("exec %q: %v", stmt, err)
	}
}

// newMarkerFileWithMarker creates a marker file under key, records one
// account marker in it and closes it, returning the path.
func newMarkerFileWithMarker(t *testing.T, key []byte) string {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "erasure", "markers.sqlite")
	m, err := OpenMarkerStore(path, key)
	if err != nil {
		t.Fatalf("OpenMarkerStore: %v", err)
	}
	if _, _, err := m.RecordPendingAccount(ctx, 42, 42); err != nil {
		t.Fatalf("RecordPendingAccount: %v", err)
	}
	if err := m.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return path
}

// A marker file names its subjects under one erasure key. Opened under
// another, every token misses, ReplayAccounts erases nothing and a restored
// backup's resurrected account serves traffic — with no error (OC-0388). So
// the file records a fingerprint of the key it was written under and refuses
// to open under any other.
func TestMarkerStore_KeyFingerprintRefusesWrongKey(t *testing.T) {
	ctx := context.Background()
	path := newMarkerFileWithMarker(t, testMarkerKey(1))

	// The key of record still opens it, and still sees its marker.
	same, err := OpenMarkerStore(path, testMarkerKey(1))
	if err != nil {
		t.Fatalf("reopen under the same key: %v", err)
	}
	markers, err := same.Markers(ctx)
	if err != nil || len(markers) != 1 {
		t.Fatalf("markers after same-key reopen = %+v, %v; want the one recorded", markers, err)
	}
	if err := same.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Any other key is refused, and refused with the fingerprint error, so
	// start-up fails closed instead of replaying nothing.
	other, err := OpenMarkerStore(path, testMarkerKey(9))
	if err == nil {
		_ = other.Close()
		t.Fatal("OpenMarkerStore with a different key succeeded; a resurrected account would go unrecognised and unerased")
	}
	if !errors.Is(err, ErrMarkerKeyMismatch) {
		t.Fatalf("wrong-key error = %v; want ErrMarkerKeyMismatch", err)
	}
}

// A marker file written before the fingerprint existed holds markers and no
// fingerprint row. Adopting whatever key is present on that first open is
// OC-0388 itself: if the erasure key was regenerated, the wrong key becomes
// the file's key of record and every marker is voided silently. It is
// refused instead, and the operator's acknowledgement statement unblocks it.
func TestMarkerStore_KeyFingerprintRefusesUnfingerprintedMarkers(t *testing.T) {
	ctx := context.Background()
	path := newMarkerFileWithMarker(t, testMarkerKey(1))
	execOnMarkerFile(t, path, `DELETE FROM marker_meta`)

	store, err := OpenMarkerStore(path, testMarkerKey(9))
	if err == nil {
		_ = store.Close()
		t.Fatal("OpenMarkerStore adopted a pre-fingerprint marker file under an unproven key; a regenerated key would void every marker silently")
	}
	if !errors.Is(err, ErrMarkerKeyUnverified) {
		t.Fatalf("unfingerprinted-file error = %v; want ErrMarkerKeyUnverified", err)
	}

	// The acknowledgement in the message is what gets the operator out.
	execOnMarkerFile(t, path,
		`INSERT INTO marker_meta (name, value) VALUES ('erasure-key-fingerprint', '`+markerKeyFingerprint(testMarkerKey(1))+`')`)
	blessed, err := OpenMarkerStore(path, testMarkerKey(1))
	if err != nil {
		t.Fatalf("after the acknowledgement, OpenMarkerStore: %v", err)
	}
	defer blessed.Close() //nolint:errcheck
	if markers, err := blessed.Markers(ctx); err != nil || len(markers) != 1 {
		t.Fatalf("markers after the acknowledgement = %+v, %v; want the one recorded", markers, err)
	}
}

// An empty marker file has nothing to protect, so the first key it is opened
// under becomes its key of record — that is how every new installation gets
// its fingerprint.
func TestMarkerStore_KeyFingerprintAdoptsEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "erasure", "markers.sqlite")
	first, err := OpenMarkerStore(path, testMarkerKey(1))
	if err != nil {
		t.Fatalf("OpenMarkerStore: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	second, err := OpenMarkerStore(path, testMarkerKey(9))
	if err == nil {
		_ = second.Close()
		t.Fatal("an empty file adopted key 1 but still opened under key 9")
	}
	if !errors.Is(err, ErrMarkerKeyMismatch) {
		t.Fatalf("wrong-key error on an adopted empty file = %v; want ErrMarkerKeyMismatch", err)
	}
}

// The mismatch branch prints a prefix of both fingerprints. A meta value
// shorter than that prefix is a corrupt or hand-edited row, not a reason for
// the security branch to panic instead of producing its operator message.
func TestMarkerStore_KeyFingerprintShortMetaValueDoesNotPanic(t *testing.T) {
	path := newMarkerFileWithMarker(t, testMarkerKey(1))
	execOnMarkerFile(t, path, `UPDATE marker_meta SET value = 'abc' WHERE name = 'erasure-key-fingerprint'`)

	store, err := OpenMarkerStore(path, testMarkerKey(1))
	if err == nil {
		_ = store.Close()
		t.Fatal("a corrupt fingerprint row opened successfully")
	}
	if !errors.Is(err, ErrMarkerKeyMismatch) {
		t.Fatalf("short-fingerprint error = %v; want ErrMarkerKeyMismatch", err)
	}
}
