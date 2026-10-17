package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// runConfigCLI implements `chatserver config reset-overrides [--all] [key ...]`
// (WP 4.7a): drop settings saved from the admin panel while the server is
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
	if len(args) == 0 || args[0] != "reset-overrides" {
		fmt.Fprintln(stderr, "error: config takes one subcommand: reset-overrides")
		configUsage(stderr)
		return 2
	}

	fs := flag.NewFlagSet("config reset-overrides", flag.ContinueOnError)
	fs.SetOutput(stderr)
	all := fs.Bool("all", false, "drop every saved panel setting (an unreadable file is moved aside, never deleted)")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	keys := fs.Args()
	if *all && len(keys) > 0 {
		fmt.Fprintln(stderr, "error: --all cannot be combined with key names")
		configUsage(stderr)
		return 2
	}
	for _, key := range keys {
		if !config.IsEditable(key) {
			fmt.Fprintf(stderr, "error: %q is not a setting saved from the admin panel (see docs/server-configuration.md for the editable keys)\n", key)
			return 2
		}
	}

	// data_dir cannot be moved by the overrides file, so the base layers find
	// it without reading the file this command is about to change.
	base, err := config.BaseConfig(cfgPath)
	if err != nil {
		fmt.Fprintf(stderr, "error: load config: %v\n", err)
		return 1
	}
	overridesPath := config.OverridesPath(base.Server.DataDir)

	if _, err := os.Stat(overridesPath); errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(stdout, "no saved panel settings (%s does not exist); nothing to reset\n", config.OverridesFileName)
		return 0
	} else if err != nil {
		fmt.Fprintf(stderr, "error: could not read %s: %v\n", config.OverridesFileName, err)
		return 1
	}

	// The panel can move database.path, so the lock goes where the server
	// would put it. When the file does not parse, no server can have booted
	// on it, so the base path cannot disagree with a running one.
	dbPath := base.Database.Path
	if effective, err := config.Preview(cfgPath, overridesPath, nil); err == nil {
		dbPath = effective.Database.Path
	}
	if dbPath == "" {
		dbPath = filepath.Join("data", "chatserver.db")
	}
	release, err := db.AcquireProcessLock(dbPath)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
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
		fmt.Fprintf(stderr, "error: %s cannot be read as saved settings, so single keys cannot be removed from it.\n"+
			"Run \"chatserver config reset-overrides --all\" to move it aside and drop every saved panel setting.\n",
			config.OverridesFileName)
		return 1
	}
	return resetKeys(stdout, stderr, overridesPath, current, keys)
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
		fmt.Fprintln(stdout, "none of those settings is saved in the overrides file; nothing to reset")
		return 0
	}
	if err := config.SaveOverrides(overridesPath, changes); err != nil {
		fmt.Fprintf(stderr, "error: could not update %s: %v\n", config.OverridesFileName, err)
		return 1
	}

	removed := sortedKeys(changes)
	fmt.Fprintf(stdout, "reset %d saved panel setting(s); config.yaml and the environment apply again for:\n", len(removed))
	for _, key := range removed {
		fmt.Fprintf(stdout, "  %s\n", key)
	}
	if len(named) > 0 && len(absent) > 0 {
		fmt.Fprintf(stdout, "not saved in the overrides file: %s\n", strings.Join(absent, ", "))
	}
	return 0
}

// resetAll drops the whole overrides layer. A file that parses is removed. One
// that does not is renamed aside, because the file holds write-only secrets and
// is never deleted unread.
func resetAll(stdout, stderr io.Writer, overridesPath string, current map[string]any, readErr error) int {
	if readErr != nil {
		aside := overridesPath + ".unreadable-" + time.Now().UTC().Format("20060102T150405Z")
		if err := os.Rename(overridesPath, aside); err != nil {
			fmt.Fprintf(stderr, "error: could not move %s aside: %v\n", config.OverridesFileName, err)
			return 1
		}
		if err := os.Chmod(aside, 0o600); err != nil {
			fmt.Fprintf(stderr, "warning: could not restrict %s to its owner: %v\n", aside, err)
		}
		fmt.Fprintf(stdout, "%s could not be read, so it was moved to %s (it may hold secrets; delete it once you no longer need it)\n",
			config.OverridesFileName, aside)
		fmt.Fprintln(stdout, "every saved panel setting is dropped; config.yaml and the environment apply again")
		return 0
	}
	if err := os.Remove(overridesPath); err != nil {
		fmt.Fprintf(stderr, "error: could not remove %s: %v\n", config.OverridesFileName, err)
		return 1
	}
	removed := sortedKeys(current)
	fmt.Fprintf(stdout, "removed %s (%d saved panel setting(s)); config.yaml and the environment apply again\n",
		config.OverridesFileName, len(removed))
	for _, key := range removed {
		fmt.Fprintf(stdout, "  %s\n", key)
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
	fmt.Fprint(w, `usage: chatserver config reset-overrides [--all] [key ...]

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
