package app

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
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

// captureLog points m's logger at a buffer and returns it.
func captureLog(m *maintenance) *bytes.Buffer {
	var buf bytes.Buffer
	m.log = slog.New(slog.NewTextHandler(&buf, nil))
	return &buf
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func TestReconcileFiles_KeepsUnreferencedUploadsWhileARestoreSafetyCopyIsFresh(t *testing.T) {
	m, uploadFile, backupDir := reconcileHoldFixture(t)
	touchSafetyCopy(t, backupDir, "pre_restore_20261111_080000.db", time.Hour)
	logs := captureLog(m)

	mustDo(t, "reconcileFiles", m.reconcileFiles(context.Background()))
	if !fileExists(uploadFile) {
		t.Fatal("an upload made since the restored backup was removed while the pre-restore copy is fresh")
	}
	// The log says until when: the copy's time plus the hold, an hour short of 7 days from now.
	if out := logs.String(); !strings.Contains(out, "skipped while a restore safety copy is fresh") || !strings.Contains(out, "until=") {
		t.Fatalf("no log line saying the pass was held and until when: %q", out)
	}
	// A later pass under the same hold still stands down, and says nothing new.
	logs.Reset()
	mustDo(t, "reconcileFiles again", m.reconcileFiles(context.Background()))
	if !fileExists(uploadFile) {
		t.Fatal("the second pass under the same hold removed the upload")
	}
	if out := logs.String(); strings.Contains(out, "skipped while a restore safety copy is fresh") {
		t.Fatalf("the same hold was announced twice: %q", out)
	}
}

func TestReconcileFiles_KeepsUploadsWhenTheBackupFolderCannotBeRead(t *testing.T) {
	m, uploadFile, _ := reconcileHoldFixture(t)
	// A regular file where the folder should be: reading it fails, but not with "does not exist".
	notAFolder := filepath.Join(t.TempDir(), "backups")
	mustDo(t, "WriteFile", os.WriteFile(notAFolder, []byte("x"), 0o600))
	m.backupDir = notAFolder
	logs := captureLog(m)

	mustDo(t, "reconcileFiles", m.reconcileFiles(context.Background()))
	if !fileExists(uploadFile) {
		t.Fatal("an upload was removed although the backup folder could not be read")
	}
	if out := logs.String(); !strings.Contains(out, "level=WARN") || !strings.Contains(out, "backup folder could not be read") {
		t.Fatalf("no warning for the unreadable backup folder: %q", out)
	}
}

func TestReconcileFiles_RemovesStrandedUploadsWhenTheBackupFolderDoesNotExist(t *testing.T) {
	m, uploadFile, _ := reconcileHoldFixture(t)
	m.backupDir = filepath.Join(t.TempDir(), "never-created")

	mustDo(t, "reconcileFiles", m.reconcileFiles(context.Background()))
	if fileExists(uploadFile) {
		t.Fatal("a stranded file was kept although there is no backup folder and so no safety copy")
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
