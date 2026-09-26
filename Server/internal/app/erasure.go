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

// markersRelPath is where the deletion markers live under the data
// directory: their own SQLite file, outside the one a backup restore
// overwrites (docs/architecture/data-lifecycle.md, O4 A3/A5).
const markersRelPath = "erasure/markers.sqlite"

// erasureKeyRelPath is the key the markers are HMAC'd under, beside totp.key.
// Named here as well as in auth because the start-up check below has to know
// whether this install has ever had one: markers cannot exist without it.
const erasureKeyRelPath = "erasure.key"

// openMarkers loads the erasure key beside totp.key, opens the marker file
// and replays every recorded marker against the freshly opened database —
// before the hub, the router or any listener exists, so a restored backup
// never serves an erased account (B4-10, BPR-053). The erasure run here is
// the full one: rows, audit unlinking and files, through the same runner
// the routes use later, minus the hub (nobody is connected yet).
func openMarkers(ctx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB) (*db.MarkerStore, error) {
	// Whether this install has an erasure key, and whether it has a marker file,
	// both read before the calls that create them.
	_, keyStatErr := os.Stat(filepath.Join(cfg.Server.DataDir, erasureKeyRelPath))
	key, err := auth.LoadOrGenerateErasureKey(cfg.Server.DataDir)
	if err != nil {
		return nil, fmt.Errorf("erasure marker key: %w", err)
	}
	markerPath := filepath.Join(cfg.Server.DataDir, markersRelPath)
	// Whether the file was there before OpenMarkerStore creates it. A missing
	// marker file is the one erasure loss nothing downstream can detect: every
	// reader sees a healthy, empty marker store, which in a restored backup is
	// indistinguishable from nothing having been erased. Measured before the
	// open, because afterwards the file exists either way.
	_, statErr := os.Stat(markerPath)
	markers, err := db.OpenMarkerStore(markerPath, key)
	if err != nil {
		return nil, fmt.Errorf("erasure markers: %w", err)
	}
	// Decided behaviour (B6-11 open question 1): boot, and log a startup error
	// that the erasure history is absent. Refusing to boot would turn a lost
	// 40 KB file into a total outage; booting silently would leave an operator
	// who deleted it by mistake with no way to learn that a restore can now
	// serve an account they erased.
	//
	// Gated on the key, which is the evidence that this install erased anything
	// before: markers are HMAC'd under it, so an install without one has no
	// history to lose. Without the gate a FIRST boot — no key file, no marker
	// file — would log the same red ERROR, and a message that fires on every
	// fresh install stops meaning "your history is gone". (A key supplied
	// through OWNCORD_ERASURE_KEY leaves no file to stat, so that configuration
	// stays silent here, exactly as it was before this check existed.)
	if errors.Is(statErr, fs.ErrNotExist) && keyStatErr == nil {
		log.Error("the erasure history is absent: the marker file was missing at start-up, so nothing can name which accounts were erased before it was lost and a restored backup may serve them again",
			"path", markersRelPath)
	}

	runner := service.NewErasureService(database)
	runner.SetMarkers(markers)
	var files service.FileRemover
	if store, storeErr := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB); storeErr != nil {
		log.Warn("erasure markers: upload storage unavailable at start-up; a replayed erasure journals its files", "error", storeErr)
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
	// The retention markers (B4-11): messages a restored backup holds past a
	// channel's recorded cutoff go again, before anything serves.
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
	// The WAL half of a restart (B6-11 task 5), and it goes after both replays
	// rather than straight after ReplayAccounts: the replay above writes too,
	// and its frames carry the same kind of content this pass exists to get out
	// of the log. An erasure that committed while the process died before its
	// checkpoint leaves its frames — erased bytes among them — in the -wal, and
	// nothing downstream would ever truncate that log: SQLite's autocheckpoint
	// is PASSIVE and leaves the file full. It runs unconditionally because the
	// flag that would name the debt is process-local and died with the process;
	// one pragma on a healthy log is the price of covering a crash.
	//
	// Best effort: a blocked checkpoint is the maintenance tick's to finish, and
	// a lost 40 KB file's worth of frames is not a reason to refuse a boot. Both
	// branches are logged because both mean bytes the operator erased are still
	// on disk.
	if truncated, err := database.CheckpointErasureWAL(ctx); err != nil {
		log.Warn("erasure: the start-up WAL checkpoint failed; the maintenance tick retries", "error", err)
	} else if !truncated {
		log.Warn("erasure: the start-up WAL checkpoint is still blocked; the maintenance tick retries")
	}
	return markers, nil
}
