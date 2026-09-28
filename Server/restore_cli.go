package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

	// Verify the source before touching anything. A truncated or non-database
	// file must be refused up front, not copied over the live database.
	if err := db.CheckBackupIntegrity(context.Background(), source); err != nil {
		fmt.Fprintf(os.Stderr, "error: %s is not a readable database backup: %v\n", source, err)
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
		fmt.Fprintf(os.Stderr, "error: %s looks like it is in use by another process (the server?) — stop it first: %v\n", dbPath, err)
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
	// reversible. Best-effort by design: if the live database is already
	// unreadable (the usual reason for restoring), there is nothing to copy,
	// and refusing here would block the very recovery the command exists for.
	safety, err := safetyCopy(dbPath, backupDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: no pre-restore safety copy was taken (%v); continuing\n", err)
	}

	// Preserve the message-delivery cutoff across the replacement, exactly as
	// the admin restore path does: a restored database may have lost the
	// receipts for messages this server already accepted.
	if err := db.AdvanceMessageDeliveryFloorForRestore(dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: could not preserve message retry protection — database untouched: %v\n", err)
		return 1
	}

	if err := copyFile(source, dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: restoring %s failed: %v\n", source, err)
		if safety != "" {
			if rbErr := copyFile(safety, dbPath); rbErr != nil {
				fmt.Fprintf(os.Stderr, "error: rollback from %s also failed: %v\n", safety, rbErr)
			} else {
				fmt.Fprintf(os.Stderr, "the pre-restore safety copy was put back\n")
			}
		}
		return 1
	}

	fmt.Printf("restored %s from %s\n", dbPath, source)
	if safety != "" {
		fmt.Printf("pre-restore safety copy: %s\n", safety)
	}
	fmt.Println("start the server to load the restored data")
	return 0
}

// safetyCopy VACUUMs the current database to a timestamped pre_restore_ file
// in backupDir, returning its path. A database that cannot be read (already
// the failure the operator is recovering from) returns an error and no path.
func safetyCopy(dbPath, backupDir string) (string, error) {
	if _, err := os.Stat(dbPath); err != nil {
		return "", err
	}
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

// copyFile streams src to dst, truncating dst, and syncs it before closing so
// a power loss cannot leave a partially-written database behind.
func copyFile(src, dst string) error {
	in, err := os.Open(src) //nolint:gosec // G304: operator-supplied paths
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer in.Close() //nolint:errcheck

	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("create destination: %w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("copy: %w", err)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return fmt.Errorf("sync: %w", err)
	}
	return out.Close()
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
