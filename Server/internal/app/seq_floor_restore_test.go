package app

import (
	"context"
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
	seedHubSeqFloor(context.Background(), &ws.Hub{}, database, log)
	raw, err := database.GetSetting(context.Background(), wsSeqFloorSettingKey)
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	floor, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		t.Fatalf("parse floor %q: %v", raw, err)
	}
	return database, floor
}

// restoreOver mirrors what both restore paths (admin panel and CLI) do to the
// files: close the live database, advance the message cutoff, drop the WAL
// files and copy the backup over the database. Neither path touches the seq
// floor, so this is the whole file-level effect.
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
	if err := db.RemoveWALSidecars(path); err != nil {
		t.Fatalf("RemoveWALSidecars: %v", err)
	}
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
	if err := db.RemoveWALSidecars(path); err != nil {
		t.Fatal(err)
	}
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

// TestSeedHubSeqFloor_OutOfRangeValuesAreTreatedAsDamaged: a stored floor too
// close to 2^53 must not wrap or be extended; boot falls back.
func TestSeedHubSeqFloor_OutOfRangeValuesAreTreatedAsDamaged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	first, _ := openAndBoot(t, path)
	if err := first.SetSetting(context.Background(), wsSeqFloorSettingKey, strconv.FormatUint(db.MaxWSSeqFloor+1, 10)); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".ws-seq-floor", []byte(strconv.FormatUint(db.MaxWSSeqFloor+1, 10)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	booted, floor := openAndBoot(t, path)
	defer booted.Close() //nolint:errcheck
	if floor != wsSeqFloorReserve {
		t.Fatalf("floor = %d, want a fresh single block %d", floor, uint64(wsSeqFloorReserve))
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
