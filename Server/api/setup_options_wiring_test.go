package api

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/sysstats"
)

// The router must hand the app's background group and shutdown signal to the
// admin API: the update apply tail runs on one and aborts on the other.
func TestAdminSetupOptions_CarryBackgroundAndShutdown(t *testing.T) {
	bg := syncutil.NewGroup(context.Background())
	shutdown := make(chan struct{})
	rt := Runtime{Background: bg, Shutdown: shutdown, SetupToken: "tok"}
	got := adminSetupOptions(&config.Config{}, rt, nil, nil, nil)
	if got.Background != bg {
		t.Error("SetupOptions.Background is not Runtime.Background")
	}
	if got.Shutdown == nil || got.Shutdown != (<-chan struct{})(shutdown) {
		t.Error("SetupOptions.Shutdown is not Runtime.Shutdown")
	}
	if got.SetupToken != "tok" {
		t.Errorf("SetupToken = %q, want tok", got.SetupToken)
	}
}

// The import routes get the configured cap, a long-transfer deadline and the
// data-directory scratch folder.
func TestAdminSetupOptions_CarryDiscordImportSettings(t *testing.T) {
	cfg := &config.Config{}
	cfg.Upload.ImportMaxMB = 7
	cfg.Server.DataDir = t.TempDir()
	got := adminSetupOptions(cfg, Runtime{}, nil, nil, nil)
	if got.ImportMaxBytes != 7<<20 {
		t.Errorf("ImportMaxBytes = %d, want %d", got.ImportMaxBytes, 7<<20)
	}
	if got.BeginTransfer == nil {
		t.Error("BeginTransfer is not set")
	}
	if want := filepath.Join(cfg.Server.DataDir, admin.ImportDirName); got.ImportDir != want {
		t.Errorf("ImportDir = %q, want %q", got.ImportDir, want)
	}
}

// The Dashboard health row gets the runtime's sampler, the data volume and the
// start time; the slow requests card gets the router's tracker.
func TestAdminSetupOptions_CarrySystemSources(t *testing.T) {
	cfg := &config.Config{}
	cfg.Server.DataDir = t.TempDir()
	sampler := sysstats.NewSampler()
	slow := metrics.NewSlowRoutes(time.Now)
	got := adminSetupOptions(cfg, Runtime{SystemStats: sampler}, nil, nil, slow).System
	if got.Sampler != sampler {
		t.Error("System.Sampler is not Runtime.SystemStats")
	}
	if got.SlowRoutes != slow {
		t.Error("System.SlowRoutes is not the router's tracker")
	}
	if got.Started.IsZero() {
		t.Error("System.Started is not set")
	}
	if got.DiskSpace == nil {
		t.Fatal("System.DiskSpace is not set")
	}
	if _, total, err := got.DiskSpace(); err != nil || total == 0 {
		t.Errorf("DiskSpace() = total %d, err %v; want the data volume", total, err)
	}
	if got.UploadBytes != nil {
		t.Error("UploadBytes set without a source")
	}
}

// Leftovers of an earlier run are removed at start-up.
func TestImportTempDir_ClearsLeftovers(t *testing.T) {
	cfg := &config.Config{}
	cfg.Server.DataDir = t.TempDir()
	dir := filepath.Join(cfg.Server.DataDir, admin.ImportDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "discord-import-1.zip")
	if err := os.WriteFile(stale, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	importTempDir(cfg)
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale upload survived start-up: %v", err)
	}
}
