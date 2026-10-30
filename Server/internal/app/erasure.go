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

// markersRelPath is where the deletion markers live under the data directory:
// their own SQLite file, outside the one a backup restore overwrites
// (docs/architecture/data-lifecycle.md).
const markersRelPath = "erasure/markers.sqlite"

// erasureKeyRelPath is the key the markers are HMAC'd under, beside totp.key.
// Named here too because the start-up check must know whether this install has
// ever had one: markers cannot exist without it.
const erasureKeyRelPath = "erasure.key"

// openMarkers loads the erasure key beside totp.key, opens the marker file and
// replays every recorded marker against the freshly opened database, before
// the hub, router or any listener exists, so a restored backup never serves an
// erased account. The erasure is the full one (rows, audit unlinking, files)
// through the same runner the routes use, minus the hub. store is the one
// upload store (nil when it could not be opened).
func openMarkers(ctx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB, store *storage.Storage) (*db.MarkerStore, error) {
	// Whether this install has an erasure key, read before the call that
	// creates it.
	_, keyStatErr := os.Stat(filepath.Join(cfg.Server.DataDir, erasureKeyRelPath))
	key, err := auth.LoadOrGenerateErasureKey(cfg.Server.DataDir)
	if err != nil {
		return nil, fmt.Errorf("erasure marker key: %w", err)
	}
	markerPath := filepath.Join(cfg.Server.DataDir, markersRelPath)
	// Whether the marker file existed before OpenMarkerStore creates it. A
	// missing file is the one erasure loss nothing downstream detects: every
	// reader sees a healthy, empty store, indistinguishable in a restored
	// backup from nothing having been erased.
	_, statErr := os.Stat(markerPath)
	markers, err := db.OpenMarkerStore(markerPath, key)
	if err != nil {
		return nil, fmt.Errorf("erasure markers: %w", err)
	}
	// Boot, and log a startup error that the erasure history is absent: refusing
	// to boot would turn a lost 40 KB file into a total outage, while booting
	// silently would leave an operator who deleted it by mistake unaware that a
	// restore can now serve an account they erased.
	//
	// Gated on the key, the evidence that this install erased anything (markers
	// are HMAC'd under it): without the gate a first boot would log the same
	// red ERROR and stop it meaning "your history is gone". A key supplied
	// through OWNCORD_ERASURE_KEY leaves no file to stat and stays silent.
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
	// The retention markers: messages a restored backup holds past a channel's
	// recorded cutoff go again, before anything serves.
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
	// The WAL half of a restart, after both replays since they write too and
	// their frames carry the content this pass exists to get out of the log. An
	// erasure that committed while the process died before its checkpoint leaves
	// erased bytes in the -wal, and SQLite's PASSIVE autocheckpoint would never
	// truncate it. It runs unconditionally because the flag naming the debt died
	// with the process; one pragma on a healthy log is the price.
	//
	// Best effort: a blocked checkpoint is the maintenance tick's to finish and
	// not a reason to refuse a boot. Both branches are logged because both mean
	// erased bytes are still on disk.
	if truncated, err := database.CheckpointErasureWAL(ctx); err != nil {
		log.Warn("erasure: the start-up WAL checkpoint failed; the maintenance tick retries", "error", err)
	} else if !truncated {
		log.Warn("erasure: the start-up WAL checkpoint is still blocked; the maintenance tick retries")
	}
	return markers, nil
}
