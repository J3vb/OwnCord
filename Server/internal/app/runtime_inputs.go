package app

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// RuntimeInputs is what StartRuntime consumes that earlier start stages
// produce or the process supplies.
type RuntimeInputs struct {
	// Version is the server version the updater compares client releases
	// against.
	Version string
	// TOTPKey is the AES-256 key from the totp-key stage; nil only in tests
	// that never touch TOTP crypto.
	TOTPKey []byte
	// Storage is the one upload file store, from OpenStorage. The erasure
	// replay needs it before StartRuntime runs, so the caller opens it once and
	// StartRuntime shares that instance with the router and the maintenance
	// loop. Nil is the degraded state: no upload, avatar or emoji routes, no
	// orphan-file cleanup, and erasures journal their files.
	Storage *storage.Storage
}

// OpenStorage opens the upload file store, logging a failure once and
// returning nil so callers degrade rather than stop (the behaviour the router
// had when it opened the store itself).
func OpenStorage(log *slog.Logger, cfg *config.Config) *storage.Storage {
	store, err := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB)
	if err != nil {
		log.Error("failed to create file storage", "error", err)
		return nil
	}
	return store
}

// beforeHubRun is a test seam: StartRuntime calls it on its own goroutine just
// before it starts the hub's dispatch loop, so a test can read the wiring as
// it stands when the first client could register. Nil in production. A
// package global: a test that sets it must not run with t.Parallel().
var beforeHubRun func(svc *service.Services)
