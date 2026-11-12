package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// runRestoreCLI implements `server restore <file>`: put a backup back on a server that will not
// boot, without the admin panel (the offline counterpart of POST /admin/api/backups/{name}/restore).
//
// Without --force it changes nothing and explains. With --force it takes a pre-restore safety copy,
// verifies the backup, then swaps it in with the panel's and boot's code (db.StageRestore,
// db.ApplyStagedRestore, which rolls back if the copy fails its check). It holds the database's
// process lock throughout and refuses while another restore is staged or half done. The config
// path is explicit so tests never start a real server.
func runRestoreCLI(cfgPath string, args []string) int {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	force := fs.Bool("force", false, "replace the live database with the backup (a pre-restore safety copy is still taken)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "error: restore takes exactly one backup file")
		restoreUsage()
		return 2
	}
	source := rest[0]

	cfg, err := config.Load(cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: load config: %v\n", err)
		return 1
	}
	dbPath := cfg.Database.Path
	if dbPath == "" {
		dbPath = filepath.Join("data", "chatserver.db")
	}

	if err := checkRestoreSource(source, dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}

	if !*force {
		fmt.Fprintf(os.Stderr, `refusing to overwrite %s with %s.

"chatserver restore" replaces the live database and everything that happened
after the backup. It refuses by default so a mistyped run cannot destroy a
working server. Pass --force to do it (a pre-restore safety copy is taken
first), or copy the file in by hand if that is what you meant to do.
`, dbPath, source)
		return 1
	}

	// The process lock: a running server holds it, so this refuses instead of swapping under it.
	lock, err := db.AcquireProcessLock(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	defer lock()

	// A staged or half-done restore would be applied at next boot over this one, so it must finish or
	// be cancelled first. The lock follows the configured path; files are replaced beside the real
	// database a symlinked path points at.
	configured := dbPath
	if real, err := filepath.EvalSymlinks(dbPath); err == nil {
		dbPath = real
	}
	if err := errors.Join(db.RestorePending(configured), db.RestorePending(dbPath)); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v — database untouched.\n", err)
		marker := configured + ".restore-pending.json"
		if _, statErr := os.Stat(dbPath + ".restore-pending.json"); statErr == nil {
			marker = dbPath + ".restore-pending.json"
		}
		if _, statErr := os.Stat(marker); statErr == nil {
			fmt.Fprintf(os.Stderr, "Start the server to finish it, or delete %s to cancel it, then run this again.\n", marker)
		} else {
			fmt.Fprintln(os.Stderr, "A swap was interrupted. Start the server once so it puts the previous database back, then run this again.")
		}
		return 1
	}

	// Staging clears leftovers under these names first, so a source among them would be deleted unread.
	if real, err := filepath.EvalSymlinks(source); err == nil && strings.HasPrefix(real, dbPath+".restore-") {
		fmt.Fprintf(os.Stderr, "error: %s is one of the restore's own working files; copy it elsewhere and restore from the copy\n", source)
		return 1
	}

	backupDir := cfg.Backup.Dir
	if backupDir == "" {
		backupDir = filepath.Join("data", "backups")
	}
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		fmt.Fprintf(os.Stderr, "error: create backup dir: %v\n", err)
		return 1
	}

	return replaceLiveDatabase(source, dbPath, backupDir, cfg.Server.MinFreeDiskBytes())
}

// replaceLiveDatabase takes the safety copy (or moves an unreadable live database aside), stages
// source and applies it with the db code the panel and boot use. The caller holds the process lock
// and has verified source and that no other restore is pending. The copy leaves reserve bytes
// free (server.min_free_disk_mb).
func replaceLiveDatabase(source, dbPath, backupDir string, reserve uint64) int {
	// The safety copy of the CURRENT database makes the overwrite reversible. It is skipped only when
	// the live database is missing or unreadable (the usual reason to restore): refusing would block
	// the recovery. Any other failure refuses, like the admin path, with the database untouched.
	safety := ""
	if err := db.CheckBackupIntegrity(context.Background(), dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "warning: the live database is missing or unreadable, so no pre-restore safety copy was taken (%v); its files will be moved aside instead\n", err)
	} else if safety, err = safetyCopy(dbPath, backupDir, reserve); err != nil {
		fmt.Fprintf(os.Stderr, "error: could not take the pre-restore safety copy — database untouched: %v\n", err)
		return 1
	}

	if !preserveFloors(dbPath) {
		dropSafetyCopy(safety)
		return 1
	}

	// With a safety copy, apply moves the live files aside and drops them once the swap holds. Without
	// one, the unreadable files are the only pre-restore state and apply deletes its own rollback file
	// on success, so move them to a name apply does not know. A dead server's -wal is never replayed.
	aside := ""
	if safety == "" {
		aside = dbPath + ".pre_restore_" + time.Now().UTC().Format("20060102_150405")
		if err := moveAside(dbPath, aside); err != nil {
			fmt.Fprintf(os.Stderr, "error: could not clear %s before restoring: %v\n", dbPath, err)
			putBack(dbPath, aside)
			dropSafetyCopy(safety)
			return 1
		}
	}

	marker := db.StagedRestoreMarker{Backup: filepath.Base(source), RequestedAt: time.Now().UTC()}
	if safety != "" {
		marker.SafetyCopy = filepath.Base(safety)
	}
	if err := db.StageRestore(context.Background(), dbPath, source, marker); err != nil {
		fmt.Fprintf(os.Stderr, "error: staging %s failed — database untouched: %v\n", source, err)
		putBack(dbPath, aside)
		dropSafetyCopy(safety)
		return 1
	}

	// Both outcomes leave <db>.restore-result.json beside the database on purpose: the next boot reads
	// it, shows it on the admin attention panel, then clears it.
	res, err := db.ApplyStagedRestore(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: applying the restore failed: %v\n", err)
		fmt.Fprintf(os.Stderr, "the restore files were left beside %s (*.restore-*) for an operator to inspect; starting the server retries or recovers the restore\n", dbPath)
		if aside != "" {
			fmt.Fprintf(os.Stderr, "the previous database files, if any, are at %s*; the next start may open an empty database, so put them back by hand if it does\n", aside)
		}
		return 1
	}
	if res.Status != db.RestoreStatusApplied {
		fmt.Fprintf(os.Stderr, "error: the restore was not applied (%s): %s\n", res.Status, res.Error)
		fmt.Fprintf(os.Stderr, "the previous database was kept\n")
		putBack(dbPath, aside)
		dropSafetyCopy(safety)
		return 1
	}

	fmt.Printf("restored %s from %s\n", dbPath, source)
	if safety != "" {
		// Success: trim old safety copies, keeping the new one and the source; a failure only warns.
		removed, pruneErr := admin.PruneSafetyCopies(backupDir, admin.SafetyCopiesKept, safety, source)
		if pruneErr != nil {
			fmt.Fprintf(os.Stderr, "warning: could not prune old safety copies: %v\n", pruneErr)
		}
		if len(removed) > 0 {
			fmt.Printf("pruned %d old safety copies\n", len(removed))
		}
		fmt.Printf("pre-restore safety copy: %s\n", safety)
	} else {
		fmt.Printf("the previous database files, if any, were moved aside to %s*\n", aside)
	}
	fmt.Println("start the server to load the restored data")
	return 0
}

// preserveFloors carries the message retry cutoff and event sequence floor past the replacement.
// It reports false, having said why, when the restore must be refused; nothing has moved yet.
func preserveFloors(dbPath string) bool {
	// Preserve the message-delivery cutoff, as the admin path does: a restored database may have lost
	// receipts for accepted messages. Apply retakes the floors, but the unreadable-live case moves
	// the live files aside first, so only this call can read them.
	if err := db.AdvanceMessageDeliveryFloorForRestore(dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: could not preserve message retry protection — database untouched: %v\n", err)
		return false
	}

	// Carry the event sequence floor too, so the next boot reserves above what the old database
	// handed out. A floor that cannot be stored refuses; a missing or unreadable live database warns.
	err := db.CarryWSSeqFloorForRestore(context.Background(), dbPath)
	if errors.Is(err, db.ErrWSSeqFloorNotStored) {
		fmt.Fprintf(os.Stderr, "error: could not preserve the event sequence floor — database untouched: %v\n", err)
		return false
	}
	if err != nil && !onlyMissingFile(err) {
		fmt.Fprintf(os.Stderr, "warning: could not carry the live event sequence floor across the restore (%v)\n", err)
	}
	return true
}

// moveAside renames dbPath and its -wal and -shm to aside plus the suffix; absent files are skipped.
func moveAside(dbPath, aside string) error {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Rename(dbPath+suffix, aside+suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("moving %s aside: %w", dbPath+suffix, err)
		}
	}
	return nil
}

// putBack undoes moveAside after a restore that did not take effect. It does nothing when no files
// were moved (aside is empty) or a real database is in place; a zero-length file is the
// placeholder a rolled-back apply leaves when there was no live database, so it is replaced.
func putBack(dbPath, aside string) {
	if aside == "" {
		return
	}
	if info, err := os.Stat(dbPath); err == nil {
		if info.Size() > 0 {
			return
		}
		if err := os.Remove(dbPath); err != nil {
			fmt.Fprintf(os.Stderr, "error: could not clear the empty placeholder %s: %v; the previous files are at %s*\n", dbPath, err, aside)
			return
		}
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Rename(aside+suffix, dbPath+suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "error: could not put %s back: %v; the previous files are at %s*\n", dbPath+suffix, err, aside)
			return
		}
	}
	fmt.Fprintf(os.Stderr, "the previous database files were put back\n")
}

// dropSafetyCopy removes the safety copy of a restore that did not happen; failure only warns.
func dropSafetyCopy(safety string) {
	if safety == "" {
		return
	}
	if err := os.Remove(safety); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "warning: could not remove the unused safety copy %s: %v\n", safety, err)
	}
}

// checkRestoreSource refuses a source unsafe to copy over dbPath, before the --force gate.
func checkRestoreSource(source, dbPath string) error {
	// SQLite verifies with the -wal applied but only the main file is copied, so a source with
	// committed WAL frames would be checked as one database and restored as another.
	if walInfo, err := os.Stat(source + "-wal"); err == nil && walInfo.Size() > 0 {
		return fmt.Errorf("%s still has transactions in %s-wal that a restore would drop; checkpoint it first (sqlite3 %s 'PRAGMA wal_checkpoint(TRUNCATE)') or restore from a backup this server wrote", source, source, source)
	}

	// Verify before touching anything: a truncated or non-database file is refused up front.
	if err := db.CheckBackupIntegrity(context.Background(), source); err != nil {
		return fmt.Errorf("%s is not a readable database backup: %w", source, err)
	}
	// A backup from a newer server would leave this binary refusing to boot, as the admin path refuses.
	ahead, err := db.CheckBackupSchemaAhead(context.Background(), source)
	if err != nil {
		return fmt.Errorf("could not read the schema version of %s: %w", source, err)
	}
	if len(ahead) > 0 {
		return fmt.Errorf("%s was written by a newer server version (unknown migrations: %s); upgrade this server before restoring it", source, strings.Join(ahead, ", "))
	}
	// Copying the live database over itself truncates it to zero bytes.
	if srcInfo, err := os.Stat(source); err == nil {
		if liveInfo, err := os.Stat(dbPath); err == nil && os.SameFile(srcInfo, liveInfo) {
			return fmt.Errorf("%s is the live database itself; restore from a copy kept elsewhere", source)
		}
	}
	return nil
}

// safetyCopy VACUUMs the current database to a timestamped pre_restore_ file in backupDir and
// returns its path; it refuses if that would leave less than reserve bytes free.
func safetyCopy(dbPath, backupDir string, reserve uint64) (string, error) {
	src, err := db.OpenShared(dbPath)
	if err != nil {
		return "", err
	}
	defer src.Close() //nolint:errcheck
	src.SetBackupDiskReserve(reserve)

	out := filepath.Join(backupDir, admin.PreRestoreBackupPrefix+time.Now().UTC().Format("20060102_150405")+".db")
	if err := src.BackupToSafe(context.Background(), out, backupDir); err != nil {
		return "", err
	}
	return out, nil
}

func restoreUsage() {
	fmt.Fprint(os.Stderr, `usage: chatserver restore [--force] <backup-file>

Put a database backup back on a server that will not boot, without the admin
panel. The file must be a backup this server wrote (POST /admin/api/backup or
the full archive's data/chatserver.db). Without --force the command makes no
change; --force replaces the live database after taking a pre-restore safety
copy, using the same staged swap as the admin panel (the previous database is
kept if the restored one fails its check). Stop the server first — it holds
the database's process lock. It refuses while another restore is staged or
unfinished: start the server to finish it, or delete the marker file
(<database>.restore-pending.json) to cancel it.
`)
}

// onlyMissingFile reports whether every error joined into err is a missing file (a live database
// that is simply absent); any other part, such as a damaged sidecar report, is still shown.
func onlyMissingFile(err error) bool {
	if joined, ok := err.(interface{ Unwrap() []error }); ok { //nolint:errorlint // walking an errors.Join tree
		for _, e := range joined.Unwrap() {
			if !onlyMissingFile(e) {
				return false
			}
		}
		return true
	}
	return errors.Is(err, os.ErrNotExist)
}
