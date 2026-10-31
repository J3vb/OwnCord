package api

import (
	"context"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Lifecycle is the part of Runtime that ties request-path work to the app's
// shutdown, handed to admin.SetupOptions by adminSetupOptions. Both are nil in
// tests that build a Runtime by hand.
type Lifecycle struct {
	// Background is the app's request-path job group; the update
	// apply tail runs on it.
	Background *syncutil.Group
	// Shutdown closes at the start of App.Close, before the HTTP drain.
	Shutdown <-chan struct{}
}

// adminSetupOptions is what the router hands the admin API: the running
// config, the setup token, the log-level controller and the app's lifecycle
// handles (the background group and the shutdown signal) the update apply
// tail needs, the Dashboard health row's and slow requests card's sources,
// and the upload directory for the Storage page.
func adminSetupOptions(cfg *config.Config, rt Runtime, importer admin.DiscordImporter, uploadBytes func(context.Context) (int64, error), slow *metrics.SlowRoutes) admin.SetupOptions {
	opts := admin.SetupOptions{
		ConfigPath: config.DefaultPath,
		RunningCfg: cfg,
		BackupDir:  cfg.Backup.Dir,
		// The restore handler stages beside the file the server opened.
		DatabasePath: cfg.Database.Path,
		SetupToken:   rt.SetupToken,
		LogLevel:     rt.LogLevel,
		Background:   rt.Background,
		Shutdown:     rt.Shutdown,

		DiscordImport:  importer,
		ImportDir:      importTempDir(cfg),
		ImportMaxBytes: cfg.Upload.ImportMaxBytes(),
		BeginTransfer:  beginImportTransfer,

		System: admin.SystemSources{
			Sampler:     rt.SystemStats,
			DiskSpace:   func() (uint64, uint64, error) { return diskutil.Space(cfg.Server.DataDir) },
			DiskMinFree: cfg.Server.MinFreeDiskBytes(),
			UploadBytes: uploadBytes,
			Started:     serverStartTime,
			SlowRoutes:  slow,
		},
	}
	// Only a real store: a typed nil pointer would make a non-nil interface.
	if rt.Storage != nil {
		opts.UploadFiles = rt.Storage
	}
	return opts
}
