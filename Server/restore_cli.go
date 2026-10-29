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

// runRestoreCLI implements `server restore <file>`: put a
// database backup back on a server that will not boot, without the admin
// panel. It is the offline counterpart to POST /admin/api/backups/{name}/restore.
//
// It refuses rather than overwrites silently. Without --force it makes no
// change and explains what to do; with --force it still takes a pre-restore
// safety copy, verifies the backup, and only then swaps it in. The swap is the
// admin panel's and the boot's: db.StageRestore stages the verified backup and
// db.ApplyStagedRestore moves the live files aside, renames the staged copy in
// and rolls back if it fails its check. The CLI holds the database's
// single-process lock for the whole operation, so a running server stops it
// rather than letting two processes fight over one file, and it refuses while
// another restore is still staged or half done.
//
// Path flags are separated from the config so a test never starts a real
// server: runRestoreCLI takes the config path explicitly.
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

	// The single-process lock: a running server holds it, so this refuses
	// rather than swapping the file under a live process.
	lock, err := db.AcquireProcessLock(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	defer lock()

	// A restore the panel staged (or one that stopped half way) would be applied
	// at the next boot over whatever this run restores, so it must finish or be
	// cancelled first.
	// The lock follows the configured path, as the server's does; the files
	// are replaced beside the real database a symlinked path points at.
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

	// Staging clears leftovers under these names first, so a source among
	// them would be deleted before it is read.
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

	return replaceLiveDatabase(source, dbPath, backupDir)
}

// replaceLiveDatabase takes the pre-restore safety copy (or moves an unreadable
// live database aside), stages source and applies it with the same db code the
// admin panel and boot use. The caller holds the process lock, has verified
// source and has checked that no other restore is pending.
func replaceLiveDatabase(source, dbPath, backupDir string) int {
	// A pre-restore safety copy of the CURRENT database, so the overwrite is
	// reversible. It is skipped only when the live database is missing or
	// unreadable (the usual reason for restoring): there is nothing to copy,
	// and refusing would block the very recovery the command exists for. Any
	// other failure refuses, like the admin path, with the database untouched.
	safety := ""
	if err := db.CheckBackupIntegrity(context.Background(), dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "warning: the live database is missing or unreadable, so no pre-restore safety copy was taken (%v); its files will be moved aside instead\n", err)
	} else if safety, err = safetyCopy(dbPath, backupDir); err != nil {
		fmt.Fprintf(os.Stderr, "error: could not take the pre-restore safety copy — database untouched: %v\n", err)
		return 1
	}

	if !preserveFloors(dbPath) {
		dropSafetyCopy(safety)
		return 1
	}

	// With a safety copy the apply moves the live database and its sidecars
	// aside itself and drops them once the swap holds. Without one, the
	// unreadable database and its sidecars are the only pre-restore state left
	// and the apply deletes its own rollback file on success, so they are moved
	// to a name the apply does not know. A dead server's -wal is never replayed
	// onto the restored file either way.
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

	// Both outcomes leave <db>.restore-result.json beside the database. It is
	// left there on purpose: the next server boot reads it, shows it on the
	// admin attention panel and then clears it.
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
		// Restore succeeded: trim old safety copies, keeping the new one and
		// the source. A failure only warns; the restore stands.
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

// preserveFloors carries the message retry cutoff and the event sequence floor
// past the replacement. It reports false, having said why, when the restore
// must be refused; nothing has been moved yet at that point.
func preserveFloors(dbPath string) bool {
	// Preserve the message-delivery cutoff across the replacement, exactly as
	// the admin restore path does: a restored database may have lost the
	// receipts for messages this server already accepted. The apply takes the
	// floors again (they are idempotent max-floors), but the unreadable-live
	// case moves the live files aside first, so only this call can read them.
	if err := db.AdvanceMessageDeliveryFloorForRestore(dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: could not preserve message retry protection — database untouched: %v\n", err)
		return false
	}

	// Carry the live event sequence floor across the replacement as well, so
	// the next boot reserves above what the old database handed out. A floor
	// that cannot be stored refuses the restore; a missing or unreadable live
	// database only warns.
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

// moveAside renames dbPath and its -wal and -shm to aside plus the same
// suffix. A file that is not there is skipped.
func moveAside(dbPath, aside string) error {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Rename(dbPath+suffix, aside+suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("moving %s aside: %w", dbPath+suffix, err)
		}
	}
	return nil
}

// putBack undoes moveAside after a restore that did not take effect, so the
// database is as the operator left it. It does nothing when no files were moved
// aside (aside is empty) or when a real database is already in place. A
// zero-length file is the empty placeholder a rolled-back apply puts back when
// there was no live database to park, so it is replaced.
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

// dropSafetyCopy removes a safety copy of a restore that did not happen. A
// failure only warns; a stray copy is harmless and the next restore prunes it.
func dropSafetyCopy(safety string) {
	if safety == "" {
		return
	}
	if err := os.Remove(safety); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "warning: could not remove the unused safety copy %s: %v\n", safety, err)
	}
}

// checkRestoreSource refuses a source that is not safe to copy over dbPath.
// It runs before the --force gate, so a refusal never touches the live files.
func checkRestoreSource(source, dbPath string) error {
	// SQLite verifies a database with its -wal applied, but only the main file
	// is copied, so a source with committed frames still in its WAL would be
	// checked as one database and restored as another.
	if walInfo, err := os.Stat(source + "-wal"); err == nil && walInfo.Size() > 0 {
		return fmt.Errorf("%s still has transactions in %s-wal that a restore would drop; checkpoint it first (sqlite3 %s 'PRAGMA wal_checkpoint(TRUNCATE)') or restore from a backup this server wrote", source, source, source)
	}

	// Verify the source before touching anything. A truncated or non-database
	// file must be refused up front, not copied over the live database.
	if err := db.CheckBackupIntegrity(context.Background(), source); err != nil {
		return fmt.Errorf("%s is not a readable database backup: %w", source, err)
	}
	// A backup a newer server wrote would leave this binary refusing to boot
	// on a schema it has never seen, exactly as the admin path refuses.
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

// safetyCopy VACUUMs the current database to a timestamped pre_restore_ file
// in backupDir, returning its path.
func safetyCopy(dbPath, backupDir string) (string, error) {
	src, err := db.OpenShared(dbPath)
	if err != nil {
		return "", err
	}
	defer src.Close() //nolint:errcheck

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

// onlyMissingFile reports whether every error joined into err is a missing
// file, the case of a live database that is simply not there. Any other part,
// such as a damaged sidecar report, still gets shown.
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
