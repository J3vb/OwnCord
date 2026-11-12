package app

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// RuntimeInputs is what StartRuntime consumes that earlier start stages produce
// or the process supplies.
type RuntimeInputs struct {
	Version string
	// TOTPKey is the AES-256 key from the totp-key stage; nil only in tests
	// that never touch TOTP crypto.
	TOTPKey []byte
	// Storage is the one upload file store, shared with the router and
	// maintenance loop. Nil is the degraded state: no upload/avatar/emoji routes, no orphan cleanup, erasures
	// journal their files.
	Storage *storage.Storage
}

// OpenStorage opens the upload file store, logging a failure once and returning
// nil so callers degrade rather than stop.
func OpenStorage(log *slog.Logger, cfg *config.Config) *storage.Storage {
	store, err := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB)
	if err != nil {
		log.Error("failed to create file storage", "error", err)
		return nil
	}
	return store
}

// beforeHubRun is a test seam called just before the hub's dispatch loop
// starts. A test that sets it must not use t.Parallel().
var beforeHubRun func(svc *service.Services)
