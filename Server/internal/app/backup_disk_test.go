package app

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

func backupDiskFixture(t *testing.T) (*config.Config, *service.SettingsService) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	root := t.TempDir()
	cfg := &config.Config{
		Server:   config.ServerConfig{DataDir: filepath.Join(root, "data")},
		Database: config.DatabaseConfig{Path: filepath.Join(root, "db", "chatserver.db")},
		Upload:   config.UploadConfig{StorageDir: filepath.Join(root, "uploads")},
		Backup:   config.BackupConfig{Dir: filepath.Join(root, "backups")},
	}
	return cfg, service.NewSettingsService(database)
}

// sameVolumeFake answers "same volume" from a table of path to volume name; a path not in it is unknown.
func sameVolumeFake(volumes map[string]string) func(a, b string) (bool, error) {
	return func(a, b string) (bool, error) {
		va, okA := volumes[a]
		vb, okB := volumes[b]
		if !okA || !okB {
			return false, errors.New("unknown path " + a + " or " + b)
		}
		return va == vb, nil
	}
}

func TestBackupDiskReading_ComparesDataDatabaseAndUploadFolders(t *testing.T) {
	cfg, settings := backupDiskFixture(t)
	dir := admin.ResolveBackupDir(cfg.Backup.Dir)
	dataDir, dbDir, upDir := cfg.Server.DataDir, filepath.Dir(cfg.Database.Path), cfg.Upload.StorageDir
	for name, tc := range map[string]struct {
		volumes map[string]string
		shared  bool
		with    string
	}{
		"all on other disks":                     {map[string]string{dir: "b", dataDir: "a", dbDir: "a", upDir: "a"}, false, ""},
		"shares the data folder's disk":          {map[string]string{dir: "a", dataDir: "a", dbDir: "c", upDir: "c"}, true, dataDir},
		"shares only the database folder's disk": {map[string]string{dir: "a", dataDir: "b", dbDir: "a", upDir: "c"}, true, dbDir},
		"shares only the uploads disk":           {map[string]string{dir: "a", dataDir: "b", dbDir: "c", upDir: "a"}, true, upDir},
	} {
		got, err := backupDiskReading(context.Background(), cfg, settings, sameVolumeFake(tc.volumes))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got.Shared != tc.shared || got.With != tc.with || got.Unknown != "" || got.Dir != dir {
			t.Errorf("%s: reading = %+v, want shared=%v with=%q", name, got, tc.shared, tc.with)
		}
	}
}

// A probe that cannot answer is unknown, and one match still wins over a failed comparison.
func TestBackupDiskReading_ProbeErrorsAreUnknownNotDifferent(t *testing.T) {
	cfg, settings := backupDiskFixture(t)
	dir := admin.ResolveBackupDir(cfg.Backup.Dir)
	broken := func(a, b string) (bool, error) { return false, errors.New("stat denied") }
	got, err := backupDiskReading(context.Background(), cfg, settings, broken)
	if err != nil {
		t.Fatal(err)
	}
	if got.Shared || got.Unknown == "" {
		t.Errorf("reading = %+v, want unknown", got)
	}

	// The data folder cannot be read, the database folder shares the disk.
	partial := func(a, b string) (bool, error) {
		if b == cfg.Server.DataDir {
			return false, errors.New("stat denied")
		}
		return b == filepath.Dir(cfg.Database.Path), nil
	}
	got, err = backupDiskReading(context.Background(), cfg, settings, partial)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Shared || got.With != filepath.Dir(cfg.Database.Path) || got.Dir != dir {
		t.Errorf("reading = %+v, want shared with the database folder", got)
	}
}

// The owner's "this is another disk" holds only for the folder it was given for.
func TestBackupDiskReading_AckHoldsOnlyForTheSameFolder(t *testing.T) {
	cfg, settings := backupDiskFixture(t)
	ctx := context.Background()
	dir := admin.ResolveBackupDir(cfg.Backup.Dir)
	allShared := func(a, b string) (bool, error) { return true, nil }

	if got, _ := backupDiskReading(ctx, cfg, settings, allShared); got.Acked {
		t.Fatal("acked with nothing stored")
	}
	if _, err := settings.Patch(ctx, 1, map[string]string{service.BackupDiskAckKey: dir}); err != nil {
		t.Fatal(err)
	}
	got, err := backupDiskReading(ctx, cfg, settings, allShared)
	if err != nil || !got.Shared || !got.Acked {
		t.Fatalf("reading = %+v, %v; want shared and acked", got, err)
	}

	cfg.Backup.Dir = filepath.Join(t.TempDir(), "elsewhere")
	if got, _ := backupDiskReading(ctx, cfg, settings, allShared); got.Acked {
		t.Error("the answer still counted after backup.dir moved")
	}
}

func TestBackupArchiveReading_ReadsScope(t *testing.T) {
	cfg, settings := backupDiskFixture(t)
	ctx := context.Background()
	// A fresh migrated database has no accounts, so it starts on everything.
	got, err := backupArchiveReading(ctx, cfg, settings)
	if err != nil || got.Scope != service.BackupScopeEverything {
		t.Fatalf("reading = %+v, %v; want everything on a fresh database", got, err)
	}
	if _, err := settings.Patch(ctx, 1, map[string]string{service.BackupScopeKey: "database"}); err != nil {
		t.Fatal(err)
	}
	if got, _ = backupArchiveReading(ctx, cfg, settings); got.Scope != service.BackupScopeDatabase {
		t.Errorf("scope = %q, want database", got.Scope)
	}
}
