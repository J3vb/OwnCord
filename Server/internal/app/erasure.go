package app

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// markersRelPath is where the deletion markers live under the data
// directory: their own SQLite file, outside the one a backup restore
// overwrites (docs/architecture/data-lifecycle.md, O4 A3/A5).
const markersRelPath = "erasure/markers.sqlite"

// openMarkers loads the erasure key beside totp.key, opens the marker file
// and replays every recorded marker against the freshly opened database —
// before the hub, the router or any listener exists, so a restored backup
// never serves an erased account (B4-10, BPR-053). The erasure run here is
// the full one: rows, audit unlinking and files, through the same runner
// the routes use later, minus the hub (nobody is connected yet).
func openMarkers(ctx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB) (*db.MarkerStore, error) {
	key, err := auth.LoadOrGenerateErasureKey(cfg.Server.DataDir)
	if err != nil {
		return nil, fmt.Errorf("erasure marker key: %w", err)
	}
	markers, err := db.OpenMarkerStore(filepath.Join(cfg.Server.DataDir, markersRelPath), key)
	if err != nil {
		return nil, fmt.Errorf("erasure markers: %w", err)
	}

	runner := service.NewErasureService(database)
	runner.SetMarkers(markers)
	if files, storeErr := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB); storeErr != nil {
		log.Warn("erasure markers: upload storage unavailable at start-up; a replayed erasure journals its files", "error", storeErr)
	} else {
		runner.SetFiles(files)
	}
	report, err := runner.ReplayMarkers(ctx)
	if err != nil {
		_ = markers.Close()
		return nil, fmt.Errorf("replaying erasure markers: %w", err)
	}
	if report.Erased > 0 || report.Confirmed > 0 || report.Discarded > 0 {
		log.Warn("erasure markers replayed", "erased_again", report.Erased, "confirmed", report.Confirmed, "discarded", report.Discarded)
	}
	return markers, nil
}
