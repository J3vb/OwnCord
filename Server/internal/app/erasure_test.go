package app

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// historyAbsentLog reports whether a start-up log says the erasure history is
// gone. The rule is deliberately the same one the drill's step 6 asserts on
// (cmd/smoke/drills.go, saysHistoryGone) — including that the two words have to
// fall on one line, because an operator greps a log one line at a time. It is
// spelled again here because that harness is another package; if the two ever
// disagree, step 6 is the one that fails.
func historyAbsentLog(log string) bool {
	for line := range strings.SplitSeq(log, "\n") {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "erasure") &&
			(strings.Contains(lower, "missing") || strings.Contains(lower, "absent") || strings.Contains(lower, "gone")) {
			return true
		}
	}
	return false
}

// The decided behaviour when the marker file was not there at start-up (B6-11
// open question 1, R10): boot — a lost 40 KB file must not become a total
// outage — and log a start-up ERROR naming the absent history, because nothing
// else can. Every other reader of a freshly created marker store sees a
// healthy, empty one, which in a restored backup is indistinguishable from
// nothing having been erased; the operator who deleted the file by mistake has
// no other way to learn that a restore may now serve an account they erased.
//
// Step 6 of the drills measures this same sequence against a built binary, but
// it skips on Windows — the running server holds the file open — so this is the
// only place the behaviour is pinned on the platform this branch was written on.
func TestOpenMarkers_MissingHistoryBootsAndSaysSo(t *testing.T) {
	t.Setenv("OWNCORD_ERASURE_KEY", "")
	dataDir := filepath.Join(t.TempDir(), "data")
	cfg := &config.Config{}
	cfg.Server.DataDir = dataDir
	cfg.Upload.StorageDir = filepath.Join(dataDir, "uploads")
	cfg.Upload.MaxSizeMB = 1
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))

	// open runs the stage and returns what it wrote to the log.
	open := func(what string) {
		t.Helper()
		logs.Reset()
		markers, err := openMarkers(ctx, log, cfg, database)
		if err != nil {
			t.Fatalf("%s: openMarkers: %v (the decision is boot, not refuse)", what, err)
		}
		if err := markers.Close(); err != nil {
			t.Fatalf("%s: closing: %v", what, err)
		}
	}

	markerPath := filepath.Join(dataDir, markersRelPath)

	// 1. A FIRST boot: no marker file, and no erasure key either, so this
	// install has no history it could have lost. It must stay silent — an ERROR
	// here would greet every new operator with a false alarm about erasure, and
	// the message would stop meaning "your history is gone".
	open("a first start-up")
	if historyAbsentLog(logs.String()) {
		t.Errorf("a first start-up claimed the erasure history was gone, but it never had one; log was:\n%s", logs.String())
	}
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("the stage did not create the marker file it booted without: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, erasureKeyRelPath)); err != nil {
		t.Fatalf("the first start-up did not generate the erasure key the gate reads: %v", err)
	}

	// 2. The install has a key and a marker file: still silence.
	open("the ordinary start-up")
	if historyAbsentLog(logs.String()) {
		t.Errorf("an ordinary start-up claimed the erasure history was gone; log was:\n%s", logs.String())
	}

	// 3. The restore deleted the marker file under the next process. The key
	// survived, so history could exist and the start-up has to say it is gone.
	for _, sidecar := range []string{markerPath, markerPath + "-wal", markerPath + "-shm"} {
		if err := os.Remove(sidecar); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	open("the start-up after the marker file was deleted")
	if !historyAbsentLog(logs.String()) {
		t.Errorf("a start-up whose marker file was deleted did not say the erasure history is gone; log was:\n%s", logs.String())
	}
	if !strings.Contains(logs.String(), "level=ERROR") {
		t.Errorf("the absent history was logged at the wrong level (the decision is a start-up error); log was:\n%s", logs.String())
	}
}

// The erasure-markers stage: the key is generated beside the data dir, the
// marker file lives under data/erasure/, and a recorded marker whose
// account is present in the database — a restored backup — is erased before
// the stage returns.
func TestOpenMarkers_ReplaysAgainstTheOpenedDatabase(t *testing.T) {
	t.Setenv("OWNCORD_ERASURE_KEY", "")
	dataDir := filepath.Join(t.TempDir(), "data")
	cfg := &config.Config{}
	cfg.Server.DataDir = dataDir
	cfg.Upload.StorageDir = filepath.Join(dataDir, "uploads")
	cfg.Upload.MaxSizeMB = 1
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := database.CreateUser(ctx, "markers-owner", "hash", 1); err != nil {
		t.Fatal(err)
	}
	uid, err := database.CreateUser(ctx, "markers-subject", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	// First open: generates the key, creates the file, nothing to replay.
	markers, err := openMarkers(ctx, log, cfg, database)
	if err != nil {
		t.Fatalf("openMarkers: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "erasure.key")); err != nil {
		t.Errorf("erasure.key not generated: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, markersRelPath)); err != nil {
		t.Errorf("marker file not created: %v", err)
	}
	// An erasure elsewhere recorded a marker; then a "restore" put the
	// account back (it was never removed from this in-memory database).
	tok, _, err := markers.RecordPendingAccount(ctx, uid, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := markers.ConfirmAccount(ctx, tok); err != nil {
		t.Fatal(err)
	}
	if err := markers.Close(); err != nil {
		t.Fatal(err)
	}

	// Second open — the next start-up: the marker is replayed.
	reopened, err := openMarkers(ctx, log, cfg, database)
	if err != nil {
		t.Fatalf("openMarkers (second): %v", err)
	}
	defer reopened.Close()
	if u, _ := database.GetUserByID(ctx, uid); u != nil {
		t.Error("the marked account survived start-up")
	}
	list, _ := reopened.Markers(ctx)
	if len(list) != 1 || list[0].Replays != 1 {
		t.Errorf("markers after start-up = %+v, want one marker replayed once", list)
	}
}

// The same stage replays the retention markers: messages past a recorded
// cutoff — a restored backup's — are removed before anything serves.
func TestOpenMarkers_ReplaysRetentionMarkers(t *testing.T) {
	t.Setenv("OWNCORD_ERASURE_KEY", "")
	dataDir := filepath.Join(t.TempDir(), "data")
	cfg := &config.Config{}
	cfg.Server.DataDir = dataDir
	cfg.Upload.StorageDir = filepath.Join(dataDir, "uploads")
	cfg.Upload.MaxSizeMB = 1
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "markers-owner", "hash", 1)
	chID, err := database.CreateChannel(ctx, "swept", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, ts := range []string{"2026-01-01 00:00:00", "2026-08-01 00:00:00"} {
		if _, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp) VALUES (?, ?, 'm', ?)`, chID, uid, ts); err != nil {
			t.Fatal(err)
		}
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	markers, err := openMarkers(ctx, log, cfg, database)
	if err != nil {
		t.Fatal(err)
	}
	if err := markers.RecordMessagesSweep(ctx, chID, "2026-06-01 00:00:00", 0); err != nil {
		t.Fatal(err)
	}
	_ = markers.Close()
	reopened, err := openMarkers(ctx, log, cfg, database)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var left int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, chID).Scan(&left)
	if left != 1 {
		t.Errorf("messages after start-up = %d, want 1 (the one past the recorded cutoff removed)", left)
	}
}
