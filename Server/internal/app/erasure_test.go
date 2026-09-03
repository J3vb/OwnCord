package app

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

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
