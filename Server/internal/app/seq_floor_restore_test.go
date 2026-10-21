package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// openAndBoot opens the database at path, runs the boot-time seq seeding the
// way startEventPersister does, and returns the handle and the floor that
// boot reserved.
func openAndBoot(t *testing.T, path string) (*db.DB, uint64) {
	t.Helper()
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := &ws.Hub{}
	seedHubSeqFloor(context.Background(), hub, database, log)
	raw, err := database.GetSetting(context.Background(), wsSeqFloorSettingKey)
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	floor, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		t.Fatalf("parse floor %q: %v", raw, err)
	}
	if got := hub.CurrentSeq(); got != floor {
		t.Fatalf("hub seq = %d, want the reserved floor %d", got, floor)
	}
	return database, floor
}

// removeWALSidecars drops dbPath's -wal and -shm, as a restore must before a
// backup is copied over the database.
func removeWALSidecars(t *testing.T, dbPath string) {
	t.Helper()
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(dbPath + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("removing %s: %v", dbPath+suffix, err)
		}
	}
}

// restoreOver mirrors what the old copy-over restore did to the
// files: close the live database, carry the live seq floor into the sidecar,
// advance the message cutoff, drop the WAL files and copy the backup over the
// database.
func restoreOver(t *testing.T, database *db.DB, path, backup string) {
	t.Helper()
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := db.CarryWSSeqFloorForRestore(context.Background(), path); err != nil {
		t.Fatalf("CarryWSSeqFloorForRestore: %v", err)
	}
	if err := db.AdvanceMessageDeliveryFloorForRestore(path); err != nil {
		t.Fatalf("AdvanceMessageDeliveryFloorForRestore: %v", err)
	}
	removeWALSidecars(t, path)
	if err := db.CopyDatabaseFile(backup, path); err != nil {
		t.Fatalf("CopyDatabaseFile: %v", err)
	}
}

// prepareRestoredScenario boots twice, takes a backup after the first boot,
// restores it and returns the floor the pre-restore server last reserved.
func prepareRestoredScenario(t *testing.T) (path string, preRestoreFloor uint64) {
	t.Helper()
	dir := t.TempDir()
	path = filepath.Join(dir, "chat.db")
	backup := filepath.Join(dir, "backup.db")

	first, _ := openAndBoot(t, path)
	if err := first.BackupToSafe(context.Background(), backup, dir); err != nil {
		t.Fatalf("BackupTo: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// The pre-restore server keeps running and reserves further blocks.
	second, floor := openAndBoot(t, path)
	restoreOver(t, second, path, backup)
	return path, floor
}

// TestSeedHubSeqFloor_RestoredBackupDoesNotReuseTheOldBlock: the backup holds
// an older ws_seq_floor than the server it replaces. Before the sidecar the
// next boot re-reserved the block the pre-restore boot had already used, so a
// pre-restore last_seq could land inside the new ring buffer.
func TestSeedHubSeqFloor_RestoredBackupDoesNotReuseTheOldBlock(t *testing.T) {
	path, preRestore := prepareRestoredScenario(t)
	booted, floor := openAndBoot(t, path)
	if floor < preRestore+wsSeqFloorReserve {
		t.Fatalf("post-restore floor %d must be at least pre-restore floor %d + reserve", floor, preRestore)
	}
	// Restoring the same backup again must not walk the floor back.
	if err := booted.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	removeWALSidecars(t, path)
	if err := db.CopyDatabaseFile(filepath.Join(filepath.Dir(path), "backup.db"), path); err != nil {
		t.Fatal(err)
	}
	again, floor2 := openAndBoot(t, path)
	defer again.Close() //nolint:errcheck
	if floor2 < floor+wsSeqFloorReserve {
		t.Fatalf("second restore of the same backup reused a block: %d < %d + reserve", floor2, floor)
	}
}

// TestSeedHubSeqFloor_RestoreCarriesTheLiveFloorWithoutASidecar: an install
// that has never written a sidecar (booted only on an older build) is
// protected by the live settings value read at restore time.
func TestSeedHubSeqFloor_RestoreCarriesTheLiveFloorWithoutASidecar(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chat.db")
	backup := filepath.Join(dir, "backup.db")
	first, _ := openAndBoot(t, path)
	if err := first.BackupToSafe(context.Background(), backup, dir); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	live, liveFloor := openAndBoot(t, path)
	if err := os.Remove(path + ".ws-seq-floor"); err != nil {
		t.Fatal(err)
	}
	restoreOver(t, live, path, backup)
	booted, floor := openAndBoot(t, path)
	defer booted.Close() //nolint:errcheck
	if floor < liveFloor+wsSeqFloorReserve {
		t.Fatalf("floor %d did not clear the live floor %d", floor, liveFloor)
	}
}

// TestSeedHubSeqFloor_OutOfRangeValuesSaturate: a stored floor within one
// block of the limit saturates at the limit, and a stored value above it is
// held at the limit; the floor never drops back to a single block, and the
// value written is one the next boot accepts unchanged.
func TestSeedHubSeqFloor_OutOfRangeValuesSaturate(t *testing.T) {
	for name, stored := range map[string]uint64{
		"within one block of the limit": db.MaxWSSeqFloor - wsSeqFloorReserve/2,
		"above the limit":               db.MaxWSSeqFloor + 1,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "chat.db")
			first, _ := openAndBoot(t, path)
			if err := first.SetSetting(context.Background(), wsSeqFloorSettingKey, strconv.FormatUint(stored, 10)); err != nil {
				t.Fatal(err)
			}
			if err := first.Close(); err != nil {
				t.Fatal(err)
			}
			booted, floor := openAndBoot(t, path)
			if floor != db.MaxWSSeqFloor {
				t.Fatalf("floor = %d, want the limit %d", floor, db.MaxWSSeqFloor)
			}
			if err := booted.Close(); err != nil {
				t.Fatal(err)
			}
			again, floor2 := openAndBoot(t, path)
			defer again.Close() //nolint:errcheck
			if floor2 != db.MaxWSSeqFloor {
				t.Fatalf("next boot moved the floor to %d, want the limit %d", floor2, db.MaxWSSeqFloor)
			}
		})
	}
}

// TestSeedHubSeqFloor_FailedSidecarWriteStillBoots: a directory sits where the
// sidecar goes, so the write fails; settings still advance and the hub seeds.
func TestSeedHubSeqFloor_FailedSidecarWriteStillBoots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	first, firstFloor := openAndBoot(t, path)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path + ".ws-seq-floor"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path+".ws-seq-floor", 0o700); err != nil {
		t.Fatal(err)
	}
	booted, floor := openAndBoot(t, path) // asserts the hub seq equals floor
	defer booted.Close()                  //nolint:errcheck
	if want := firstFloor + wsSeqFloorReserve; floor != want {
		t.Fatalf("settings floor = %d, want %d", floor, want)
	}
}

// TestSeedHubSeqFloor_FailedSettingsWriteStillSeedsTheHub: the settings write
// fails but the sidecar holds the block, so the hub is seeded from it.
func TestSeedHubSeqFloor_FailedSettingsWriteStillSeedsTheHub(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	first, firstFloor := openAndBoot(t, path)
	defer first.Close() //nolint:errcheck
	if _, err := first.ExecContext(context.Background(),
		`CREATE TRIGGER block_floor_update BEFORE UPDATE ON settings WHEN NEW.key = 'ws_seq_floor'
		 BEGIN SELECT RAISE(ABORT, 'blocked'); END`); err != nil {
		t.Fatal(err)
	}
	hub := &ws.Hub{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	seedHubSeqFloor(context.Background(), hub, first, log)
	want := firstFloor + wsSeqFloorReserve
	if got := hub.CurrentSeq(); got != want {
		t.Fatalf("hub seq = %d, want %d", got, want)
	}
	if got, ok, err := first.WSSeqFloorSidecar(); err != nil || !ok || got != want {
		t.Fatalf("sidecar = %d ok=%v err=%v, want %d", got, ok, err, want)
	}
	raw, err := first.GetSetting(context.Background(), wsSeqFloorSettingKey)
	if err != nil || raw != strconv.FormatUint(firstFloor, 10) {
		t.Fatalf("settings = %q err=%v, want unchanged %d", raw, err, firstFloor)
	}
}

// TestSeedHubSeqFloor_UnreadableSettingsUseTheSidecar: the settings read fails
// (database handle closed); the sidecar value is used instead of giving up.
func TestSeedHubSeqFloor_UnreadableSettingsUseTheSidecar(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	first, firstFloor := openAndBoot(t, path)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	hub := &ws.Hub{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	seedHubSeqFloor(context.Background(), hub, first, log)
	want := firstFloor + wsSeqFloorReserve
	if got := hub.CurrentSeq(); got != want {
		t.Fatalf("hub seq = %d, want %d", got, want)
	}
}

// TestSeedHubSeqFloor_MissingOrCorruptSidecarFallsBack: boot never fails over
// the sidecar; it uses the settings value, which is the old behaviour.
func TestSeedHubSeqFloor_MissingOrCorruptSidecarFallsBack(t *testing.T) {
	for name, contents := range map[string]*string{"missing": nil, "corrupt": new("not-a-number")} {
		t.Run(name, func(t *testing.T) {
			path, _ := prepareRestoredScenario(t)
			sidecar := path + ".ws-seq-floor"
			if contents == nil {
				if err := os.Remove(sidecar); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(sidecar, []byte(*contents), 0o600); err != nil {
				t.Fatal(err)
			}
			booted, floor := openAndBoot(t, path)
			defer booted.Close() //nolint:errcheck
			// Restored settings hold the first boot's floor, so one block up.
			if want := 2 * uint64(wsSeqFloorReserve); floor != want {
				t.Fatalf("fallback floor = %d, want %d", floor, want)
			}
			got, ok, err := booted.WSSeqFloorSidecar()
			if err != nil || !ok || got != floor {
				t.Fatalf("sidecar after boot = %d ok=%v err=%v, want %d", got, ok, err, floor)
			}
		})
	}
}
