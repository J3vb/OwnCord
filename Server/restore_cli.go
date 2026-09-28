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

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// runRestoreCLI implements `server restore <file>` (B11-7, OP-10): put a
// database backup back on a server that will not boot, without the admin
// panel. It is the offline counterpart to POST /admin/api/backups/{name}/restore.
//
// It refuses rather than overwrites silently. Without --force it makes no
// change and explains what to do; with --force it still takes a pre-restore
// safety copy, verifies the backup, and only then replaces the live file. It
// holds the database's single-process lock for the whole operation, so a
// running server stops it rather than letting two processes fight over one
// file.
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

	// SQLite verifies a database with its -wal applied, but only the main file
	// is copied, so a source with committed frames still in its WAL would be
	// checked as one database and restored as another.
	if walInfo, err := os.Stat(source + "-wal"); err == nil && walInfo.Size() > 0 {
		fmt.Fprintf(os.Stderr, "error: %s still has transactions in %s-wal that a restore would drop; checkpoint it first (sqlite3 %s 'PRAGMA wal_checkpoint(TRUNCATE)') or restore from a backup this server wrote\n", source, source, source)
		return 1
	}

	// Verify the source before touching anything. A truncated or non-database
	// file must be refused up front, not copied over the live database.
	if err := db.CheckBackupIntegrity(context.Background(), source); err != nil {
		fmt.Fprintf(os.Stderr, "error: %s is not a readable database backup: %v\n", source, err)
		return 1
	}
	// A backup a newer server wrote would leave this binary refusing to boot
	// on a schema it has never seen (REL-02), exactly as the admin path refuses.
	ahead, err := db.CheckBackupSchemaAhead(context.Background(), source)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: could not read the schema version of %s: %v\n", source, err)
		return 1
	}
	if len(ahead) > 0 {
		fmt.Fprintf(os.Stderr, "error: %s was written by a newer server version (unknown migrations: %s); upgrade this server before restoring it\n", source, strings.Join(ahead, ", "))
		return 1
	}
	// Copying the live database over itself truncates it to zero bytes.
	if srcInfo, err := os.Stat(source); err == nil {
		if liveInfo, err := os.Stat(dbPath); err == nil && os.SameFile(srcInfo, liveInfo) {
			fmt.Fprintf(os.Stderr, "error: %s is the live database itself; restore from a copy kept elsewhere\n", source)
			return 1
		}
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

	backupDir := cfg.Backup.Dir
	if backupDir == "" {
		backupDir = filepath.Join("data", "backups")
	}
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		fmt.Fprintf(os.Stderr, "error: create backup dir: %v\n", err)
		return 1
	}

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

	// Preserve the message-delivery cutoff across the replacement, exactly as
	// the admin restore path does: a restored database may have lost the
	// receipts for messages this server already accepted.
	if err := db.AdvanceMessageDeliveryFloorForRestore(dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: could not preserve message retry protection — database untouched: %v\n", err)
		return 1
	}

	// A dead server's -wal would be replayed onto the restored file on the next
	// boot, so no sidecar may stay beside it. With a safety copy they hold
	// nothing it did not capture. Without one, the unreadable database and its
	// sidecars are the only pre-restore state left, so they are moved aside
	// rather than truncated and deleted.
	aside := ""
	if safety == "" {
		aside = dbPath + ".pre_restore_" + time.Now().UTC().Format("20060102_150405")
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		var err error
		switch {
		case aside != "":
			err = os.Rename(dbPath+suffix, aside+suffix)
		case suffix != "":
			err = os.Remove(dbPath + suffix)
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "error: could not clear %s before restoring: %v\n", dbPath+suffix, err)
			return 1
		}
	}

	if err := db.CopyDatabaseFile(source, dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: restoring %s failed: %v\n", source, err)
		if safety != "" {
			if rbErr := db.CopyDatabaseFile(safety, dbPath); rbErr != nil {
				fmt.Fprintf(os.Stderr, "error: rollback from %s also failed: %v\n", safety, rbErr)
			} else {
				fmt.Fprintf(os.Stderr, "the pre-restore safety copy was put back\n")
			}
		} else {
			fmt.Fprintf(os.Stderr, "the previous database files, if any, are at %s*\n", aside)
		}
		return 1
	}

	fmt.Printf("restored %s from %s\n", dbPath, source)
	if safety != "" {
		fmt.Printf("pre-restore safety copy: %s\n", safety)
	} else {
		fmt.Printf("the previous database files, if any, were moved aside to %s*\n", aside)
	}
	fmt.Println("start the server to load the restored data")
	return 0
}

// safetyCopy VACUUMs the current database to a timestamped pre_restore_ file
// in backupDir, returning its path.
func safetyCopy(dbPath, backupDir string) (string, error) {
	src, err := db.OpenShared(dbPath)
	if err != nil {
		return "", err
	}
	defer src.Close() //nolint:errcheck

	out := filepath.Join(backupDir, "pre_restore_"+time.Now().UTC().Format("20060102_150405")+".db")
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
copy. Stop the server first — it holds the database's process lock.
`)
}
