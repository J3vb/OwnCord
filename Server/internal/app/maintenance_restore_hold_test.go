package app

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// reconcileHoldFixture is a maintenance pass over a database with no attachment
// rows and an upload folder holding one file older than the grace hour.
func reconcileHoldFixture(t *testing.T) (m *maintenance, uploadFile, backupDir string) {
	t.Helper()
	database := newMaintenanceTestDB(t)
	uploads := t.TempDir()
	backupDir = t.TempDir()
	uploadFile = filepath.Join(uploads, "uploaded-since-backup")
	mustDo(t, "WriteFile", os.WriteFile(uploadFile, []byte("x"), 0o600))
	old := time.Now().Add(-48 * time.Hour)
	mustDo(t, "Chtimes", os.Chtimes(uploadFile, old, old))
	files, err := storage.New(uploads, 10)
	mustDo(t, "storage.New", err)
	erasure := service.NewErasureService(database)
	erasure.SetFiles(files)
	m = &maintenance{log: slog.Default(), database: database, files: files, erasure: erasure, backupDir: backupDir}
	return m, uploadFile, backupDir
}

func touchSafetyCopy(t *testing.T, dir, name string, age time.Duration) {
	t.Helper()
	p := filepath.Join(dir, name)
	mustDo(t, "WriteFile", os.WriteFile(p, []byte("db"), 0o600))
	when := time.Now().Add(-age)
	mustDo(t, "Chtimes", os.Chtimes(p, when, when))
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func TestReconcileFiles_KeepsUnreferencedUploadsWhileARestoreSafetyCopyIsFresh(t *testing.T) {
	m, uploadFile, backupDir := reconcileHoldFixture(t)
	touchSafetyCopy(t, backupDir, "pre_restore_20261111_080000.db", time.Hour)

	mustDo(t, "reconcileFiles", m.reconcileFiles(context.Background()))
	if !fileExists(uploadFile) {
		t.Fatal("an upload made since the restored backup was removed while the pre-restore copy is fresh")
	}
}

func TestReconcileFiles_RemovesStrandedUploadsOnceTheRestoreCopyHasAgedOut(t *testing.T) {
	m, uploadFile, backupDir := reconcileHoldFixture(t)
	// An old pre_restore_ copy and a fresh ordinary backup must not hold the pass.
	touchSafetyCopy(t, backupDir, "pre_restore_20260101_080000.db", restoreFileHold+time.Hour)
	touchSafetyCopy(t, backupDir, "chatserver_20261111_030000.db", time.Hour)

	mustDo(t, "reconcileFiles", m.reconcileFiles(context.Background()))
	if fileExists(uploadFile) {
		t.Fatal("a stranded file was kept although no recent restore left a safety copy")
	}
}
