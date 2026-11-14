package app

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/linkpreview"
)

// The thumbnail sweep runs with link_previews.enabled off and trims down to the cap, on the
// one store the composition root opened.
func TestMaintenance_SweepLinkPreviewsTrimsWhileDisabled(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	database := newMaintenanceTestDB(t)
	cfg := &config.Config{Server: config.ServerConfig{DataDir: dataDir}}
	cfg.LinkPreviews = config.LinkPreviewsConfig{Enabled: false, ThumbnailCacheMB: 0, ThumbnailUnusedDays: 30}

	store := OpenLinkPreviews(slog.Default(), cfg, database)
	if store == nil {
		t.Fatal("no link preview store was opened from server.data_dir")
	}
	m := newMaintenance(slog.Default(), cfg, database, nil, nil)
	m.linkPreviews = store

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
		t.Fatal("a store was set without being passed in")
	}
	mustDo(t, "sweepLinkPreviews", m.sweepLinkPreviews(context.Background()))
	if OpenLinkPreviews(slog.Default(), &config.Config{}, nil) != nil {
		t.Error("a store was opened without a data dir")
	}
}

// A card no message names and nothing has shown for thumbnail_unused_days is removed by the
// sweep; a recent one stays.
func TestMaintenance_SweepLinkPreviewsPrunesUnreferencedCards(t *testing.T) {
	ctx := context.Background()
	database := newMaintenanceTestDB(t)
	cfg := &config.Config{Server: config.ServerConfig{DataDir: t.TempDir()}}
	cfg.LinkPreviews = config.LinkPreviewsConfig{ThumbnailCacheMB: 10, ThumbnailUnusedDays: 30}
	store := OpenLinkPreviews(slog.Default(), cfg, database)
	m := newMaintenance(slog.Default(), cfg, database, nil, nil)
	m.linkPreviews = store

	oldStamp := linkpreview.FormatTime(time.Now().Add(-60 * 24 * time.Hour))
	newStamp := linkpreview.FormatTime(time.Now())
	mustDo(t, "old card", store.PutPreview(ctx, linkpreview.Preview{UrlHash: "old", Url: "https://a/", FetchedAt: oldStamp, LastUsedAt: oldStamp}))
	mustDo(t, "new card", store.PutPreview(ctx, linkpreview.Preview{UrlHash: "new", Url: "https://b/", FetchedAt: newStamp, LastUsedAt: newStamp}))

	mustDo(t, "sweepLinkPreviews", m.sweepLinkPreviews(ctx))
	if _, err := store.Preview(ctx, "old"); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("old unreferenced card err = %v; want ErrNotFound", err)
	}
	if _, err := store.Preview(ctx, "new"); err != nil {
		t.Errorf("recent card: %v", err)
	}
}
