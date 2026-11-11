package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// markersRelPath is the deletion markers' own SQLite file, outside the one a
// backup restore overwrites (docs/architecture/data-lifecycle.md).
const markersRelPath = "erasure/markers.sqlite"

// erasureKeyRelPath is the key the markers are HMAC'd under; the start-up check
// needs it to know whether this install ever erased anything.
const erasureKeyRelPath = "erasure.key"

// openMarkers loads the erasure key, opens the marker file and replays every
// recorded marker against the freshly opened database before anything serves,
// so a restored backup never serves an erased account. store is the upload
// store (nil when it could not be opened).
func openMarkers(ctx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB, store *storage.Storage) (*db.MarkerStore, error) {
	_, keyStatErr := os.Stat(filepath.Join(cfg.Server.DataDir, erasureKeyRelPath))
	key, err := auth.LoadOrGenerateErasureKey(cfg.Server.DataDir)
	if err != nil {
		return nil, fmt.Errorf("erasure marker key: %w", err)
	}
	markerPath := filepath.Join(cfg.Server.DataDir, markersRelPath)
	_, statErr := os.Stat(markerPath)
	markers, err := db.OpenMarkerStore(markerPath, key)
	if err != nil {
		return nil, fmt.Errorf("erasure markers: %w", err)
	}
	// Boot and log an error that the history is absent: refusing would turn a
	// lost 40 KB file into a total outage, while silence would leave the
	// operator unaware that a restore can serve an account they erased.
	// Gated on the key file: without it a first boot would log the same error; an env key stays silent.
	if errors.Is(statErr, fs.ErrNotExist) && keyStatErr == nil {
		log.Error("the erasure history is absent: the marker file was missing at start-up, so nothing can name which accounts were erased before it was lost and a restored backup may serve them again",
			"path", markersRelPath)
	}

	runner := service.NewErasureService(database)
	runner.SetMarkers(markers)
	var files service.FileRemover
	if store == nil {
		log.Warn("erasure markers: upload storage unavailable at start-up; a replayed erasure journals its files")
	} else {
		files = store
		runner.SetFiles(store)
	}
	report, err := runner.ReplayMarkers(ctx)
	if err != nil {
		_ = markers.Close()
		return nil, fmt.Errorf("replaying erasure markers: %w", err)
	}
	if report.Erased > 0 || report.Confirmed > 0 {
		log.Warn("erasure markers replayed", "erased", report.Erased, "confirmed", report.Confirmed)
	}
	retention := service.NewRetentionService(database)
	retention.SetMarkers(markers)
	if files != nil {
		retention.SetFiles(files)
	}
	if removed, err := retention.ReplayMarkers(ctx); err != nil {
		_ = markers.Close()
		return nil, fmt.Errorf("replaying retention markers: %w", err)
	} else if removed > 0 {
		log.Warn("retention markers replayed", "messages_removed", removed)
	}
	// The WAL checkpoint runs after both replays, since they write too and
	// their frames carry the content this pass exists to purge.
	if truncated, err := database.CheckpointErasureWAL(ctx); err != nil {
		log.Warn("erasure: the start-up WAL checkpoint failed; the maintenance tick retries", "error", err)
	} else if !truncated {
		log.Warn("erasure: the start-up WAL checkpoint is still blocked; the maintenance tick retries")
	}
	return markers, nil
}
