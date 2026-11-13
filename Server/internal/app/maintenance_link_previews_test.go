package app

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/linkpreview"
)

// The thumbnail sweep runs with link_previews.enabled off and trims down to the cap.
func TestMaintenance_SweepLinkPreviewsTrimsWhileDisabled(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	database := newMaintenanceTestDB(t)
	cfg := &config.Config{Server: config.ServerConfig{DataDir: dataDir}}
	cfg.LinkPreviews = config.LinkPreviewsConfig{Enabled: false, ThumbnailCacheMB: 0, ThumbnailUnusedDays: 30}
	m := newMaintenance(slog.Default(), cfg, database, nil, nil)
	if m.linkPreviews == nil {
		t.Fatal("no link preview store was built from server.data_dir")
	}

	store, err := linkpreview.NewStore(database, filepath.Join(dataDir, linkpreview.DirName))
	if err != nil {
		t.Fatal(err)
	}
	hash, err := store.PutImage(ctx, []byte("thumbnail"), "image/webp", 4, 4)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dataDir, linkpreview.DirName, hash[:2], hash)

	mustDo(t, "sweepLinkPreviews", m.sweepLinkPreviews(ctx))
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Errorf("thumbnail still on disk with a 0 MB cap: %v", err)
	}
}

func TestMaintenance_SweepLinkPreviewsNoStoreIsNoop(t *testing.T) {
	m := newMaintenance(slog.Default(), &config.Config{}, newMaintenanceTestDB(t), nil, nil)
	if m.linkPreviews != nil {
		t.Fatal("a store was built without a data dir")
	}
	mustDo(t, "sweepLinkPreviews", m.sweepLinkPreviews(context.Background()))
}
