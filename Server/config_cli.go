package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// runConfigCLI implements `chatserver config reset-overrides [--all] [key ...]`:
// drop settings saved from the admin panel while the server is
// stopped, so an owner whose panel change made the panel unreachable can start
// the server again without a shell or a hand-edit of the overrides file.
//
// It is offline and modelled on `restore`: it takes the database's process
// lock, so it refuses while a server is running and cannot race a panel save.
// It never calls config.Load, which writes a default config.yaml and fails on
// an unparseable overrides file. It prints key names only, never values.
//
// Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 usage error.
func runConfigCLI(cfgPath string, args []string) int {
	return configCLI(os.Stdout, os.Stderr, cfgPath, args)
}

func configCLI(stdout, stderr io.Writer, cfgPath string, args []string) int {
	// The config package logs one INFO line per override it applies; those are
	// noise here. Warnings and the command's own output stay.
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	defer slog.SetDefault(prev)

	if len(args) == 0 || args[0] != "reset-overrides" {
		sayln(stderr, "error: config takes one subcommand: reset-overrides")
		configUsage(stderr)
		return 2
	}

	fs := flag.NewFlagSet("config reset-overrides", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { configUsage(stderr) }
	all := fs.Bool("all", false, "drop every saved panel setting (an unreadable file is moved aside, never deleted)")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	keys := fs.Args()
	if *all && len(keys) > 0 {
		sayln(stderr, "error: --all cannot be combined with key names")
		configUsage(stderr)
		return 2
	}
	for _, key := range keys {
		if !config.IsEditable(key) {
			sayf(stderr, "error: %q is not a setting saved from the admin panel (see docs/server-configuration.md for the editable keys)\n", key)
			return 2
		}
	}

	// data_dir cannot be moved by the overrides file, so the base layers find
	// it without reading the file this command is about to change.
	base, err := config.BaseConfig(cfgPath)
	if err != nil {
		sayf(stderr, "error: load config: %v\n", err)
		return 1
	}
	overridesPath := config.OverridesPath(base.Server.DataDir)

	if _, err := os.Stat(overridesPath); errors.Is(err, os.ErrNotExist) {
		sayf(stdout, "no saved panel settings (%s does not exist); nothing to reset\n", overridesPath)
		return 0
	} else if err != nil {
		sayf(stderr, "error: could not read %s: %v\n", config.OverridesFileName, err)
		return 1
	}

	release, ok := lockServerPaths(stderr, cfgPath, overridesPath, base.Database.Path)
	if !ok {
		return 1
	}
	defer release()

	// Read under the lock, so the file cannot change between the read and the
	// write.
	current, readErr := config.ReadOverrides(overridesPath)
	if *all {
		return resetAll(stdout, stderr, overridesPath, current, readErr)
	}
	if readErr != nil {
		sayf(stderr, "error: %s cannot be read as saved settings, so single keys cannot be removed from it.\n"+
			"Run \"chatserver config reset-overrides --all\" to move it aside and drop every saved panel setting.\n",
			config.OverridesFileName)
		return 1
	}
	return resetKeys(stdout, stderr, overridesPath, current, keys)
}

// lockServerPaths takes the process lock at every database path a running
// server may hold. The panel can move database.path, and a running server
// holds the lock at the path it booted with, which is the base path unless an
// earlier save has since been applied by a restart. Both the base path and the
// path the overrides now name are locked (base first, always), so a pending
// move cannot let this command rewrite the file under a live server. A saved
// chain A -> B -> C with no restart in between is not covered: the server does
// not record the path it is running on. When the file does not parse, no
// server can have booted on it, so only the base path applies.
func lockServerPaths(stderr io.Writer, cfgPath, overridesPath, baseDBPath string) (release func(), ok bool) {
	lockPaths := []string{lockTarget(baseDBPath)}
	if effective, err := config.Preview(cfgPath, overridesPath, nil); err == nil {
		// One file can be named two ways (relative and absolute); a second
		// lock on it would fail against our own first one.
		if p := lockTarget(effective.Database.Path); p != lockPaths[0] {
			lockPaths = append(lockPaths, p)
		}
	}
	var releases []func()
	releaseAll := func() {
		for _, r := range slices.Backward(releases) {
			r()
		}
	}
	for _, p := range lockPaths {
		r, held := lockDatabase(stderr, p)
		if !held {
			releaseAll()
			return nil, false
		}
		releases = append(releases, r)
	}
	return releaseAll, true
}

// lockTarget is the absolute, cleaned database path the lock is taken for,
// so two spellings of one file compare equal.
func lockTarget(dbPath string) string {
	if dbPath == "" {
		dbPath = filepath.Join("data", "chatserver.db")
	}
	if abs, err := filepath.Abs(dbPath); err == nil {
		return abs
	}
	return filepath.Clean(dbPath)
}

// lockDatabase takes the process lock for dbPath. When the database's
// directory does not exist, no process can hold the lock, so the reset may
// proceed (a server cannot boot there either). Any other failure, including
// another process holding the lock, refuses (ok=false, after printing why).
func lockDatabase(stderr io.Writer, dbPath string) (release func(), ok bool) {
	release, err := db.AcquireProcessLock(dbPath)
	if err == nil {
		return release, true
	}
	if !errors.Is(err, db.ErrAlreadyLocked) {
		if _, statErr := os.Stat(filepath.Dir(dbPath)); errors.Is(statErr, os.ErrNotExist) {
			sayf(stderr, "note: %s does not exist, so no server can be using %s\n", filepath.Dir(dbPath), dbPath)
			return func() {}, true
		}
	}
	sayf(stderr, "error: %v\n", err)
	return nil, false
}

// resetKeys removes the named keys, or, with none named, every key whose wrong
// value can lock the owner out (config.RequiresConfirmation). Settings that are
// not in the file are reported and left alone.
func resetKeys(stdout, stderr io.Writer, overridesPath string, current map[string]any, named []string) int {
	candidates := named
	if len(candidates) == 0 {
		for _, key := range config.EditableKeys() {
			if config.RequiresConfirmation(key) {
				candidates = append(candidates, key)
			}
		}
	}

	changes := make(map[string]any)
	var absent []string
	for _, key := range candidates {
		if _, ok := current[key]; ok {
			changes[key] = nil
		} else {
			absent = append(absent, key)
		}
	}
	if len(changes) == 0 {
		sayf(stdout, "none of those settings is saved in %s; nothing to reset\n", overridesPath)
		return 0
	}
	if err := config.SaveOverrides(overridesPath, changes); err != nil {
		sayf(stderr, "error: could not update %s: %v\n", config.OverridesFileName, err)
		return 1
	}

	removed := sortedKeys(changes)
	sayf(stdout, "checked %s\n", overridesPath)
	sayf(stdout, "reset %d saved panel setting(s); config.yaml and the environment apply again for:\n", len(removed))
	for _, key := range removed {
		sayf(stdout, "  %s\n", key)
	}
	if len(named) > 0 && len(absent) > 0 {
		sayf(stdout, "not saved in the overrides file: %s\n", strings.Join(absent, ", "))
	}
	return 0
}

// resetAll drops the whole overrides layer. A file that parses is removed. One
// that does not is renamed aside, because the file holds write-only secrets and
// is never deleted unread.
func resetAll(stdout, stderr io.Writer, overridesPath string, current map[string]any, readErr error) int {
	if readErr != nil {
		aside := overridesPath + ".unreadable-" + time.Now().UTC().Format("20060102T150405Z")
		for n := 2; ; n++ {
			_, err := os.Lstat(aside)
			if errors.Is(err, os.ErrNotExist) {
				break
			}
			if err != nil || n > 100 {
				sayf(stderr, "error: could not choose a name to move %s aside to\n", config.OverridesFileName)
				return 1
			}
			aside = fmt.Sprintf("%s.unreadable-%s-%d", overridesPath, time.Now().UTC().Format("20060102T150405Z"), n)
		}
		if err := os.Rename(overridesPath, aside); err != nil {
			sayf(stderr, "error: could not move %s aside: %v\n", config.OverridesFileName, err)
			return 1
		}
		if err := os.Chmod(aside, 0o600); err != nil {
			sayf(stderr, "warning: could not restrict %s to its owner: %v\n", aside, err)
		}
		sayf(stdout, "%s could not be read, so it was moved to %s (it may hold secrets; delete it once you no longer need it)\n",
			config.OverridesFileName, aside)
		sayln(stdout, "every saved panel setting is dropped; config.yaml and the environment apply again")
		return 0
	}
	if err := os.Remove(overridesPath); err != nil {
		sayf(stderr, "error: could not remove %s: %v\n", config.OverridesFileName, err)
		return 1
	}
	removed := sortedKeys(current)
	sayf(stdout, "removed %s (%d saved panel setting(s)); config.yaml and the environment apply again\n",
		config.OverridesFileName, len(removed))
	for _, key := range removed {
		sayf(stdout, "  %s\n", key)
	}
	return 0
}

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		out = append(out, key)
	}
	slices.Sort(out)
	return out
}

func configUsage(w io.Writer) {
	say(w, `usage: chatserver config reset-overrides [--all] [key ...]

Drop settings saved from the admin panel, so config.yaml and the environment
apply again. Run it with the server stopped; it refuses while one is running.

  (no arguments)  remove the saved settings that can put the panel out of
                  reach: ports, TLS, the admin allowlist, trusted proxies and
                  host paths. Tuning values and secrets stay.
  key ...         remove only the named panel-editable keys.
  --all           remove every saved panel setting. A file that cannot be read
                  is moved aside, not deleted.

It prints the names of the keys it removed, never their values.
`)
}

// sayf, sayln and say write the command's output. A failed write to the
// terminal leaves nothing more useful to report, so their errors are dropped.
func sayf(w io.Writer, format string, a ...any) { _, _ = fmt.Fprintf(w, format, a...) }

func sayln(w io.Writer, a ...any) { _, _ = fmt.Fprintln(w, a...) }

func say(w io.Writer, a ...any) { _, _ = fmt.Fprint(w, a...) }
