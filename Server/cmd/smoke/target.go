package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// target is one deployment mode under rehearsal. The fixture and every
// assertion are identical for both; only starting, stopping and swapping a
// version differ, which is the whole reason this seam exists.
type target interface {
	start(version string) error // "old" | "new" — reaches healthy or errors
	drain() error               // graceful stop, exit 0 inside drainBudget
	baseURL() string
	// installDir is the local directory captureState reads: config.yaml at its
	// root, data/ beneath. It returns an error because for the container leg it
	// copies the live state out, and a failed copy would hand back the previous
	// phase's state, so every assertion would pass over bytes never read.
	installDir() (string, error)
	archive(dir string) error // copy the live data dir out, as an owner would
	restore(dir string) error // put it back
	// annotate attaches the running server's log tail to a phase failure, as
	// server.annotate does for the plain smoke.
	annotate(phase string, cause error) error
	// log is everything the running server has printed so far.
	log() (string, error)
	cleanup() // release the temp dir or volume; safe on a half-built target
}

var (
	_ target = (*standaloneTarget)(nil)
	_ target = (*dockerTarget)(nil) // the container leg, in docker.go
)

// defaultBaseURL is where the default config.yaml puts the server: port 8443,
// self-signed TLS, and admin_allowed_cidrs covering 127.0.0.0/8, so loopback is
// reachable and admin-authorised without editing the file the rehearsal hashes.
const defaultBaseURL = "https://127.0.0.1:8443"

// noLiveKitDownload goes into the environment of every server this rehearsal
// launches: a cold boot otherwise fetches the ~40 MB LiveKit server into the
// data directory, turning the byte-for-byte comparison into a race against a
// download. OWNCORD_<SECTION>_<KEY> overrides a key without rewriting
// config.yaml.
const noLiveKitDownload = "OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT=false"

// spawnRestart pins the standalone server's self-restart (backup restore,
// update, setup) to spawning its own replacement, which is what the drills wait
// for. Auto-detection reads INVOCATION_ID as "systemd will relaunch me", and a
// GitHub-hosted runner's agent is a systemd service, so every job inherits it
// and the server would exit for a supervisor that never comes. The container
// leg stays supervised; its engine does relaunch it.
const spawnRestart = "OWNCORD_SERVER_RESTART_MODE=spawn"

// setupTokenLine matches the first-run setup token in the server's start-up
// output; an older release prints none.
var setupTokenLine = regexp.MustCompile(`Setup token\s+(\S+)`)

// setupTokenIn returns the last setup token in a server's output, or "" when
// it printed none.
func setupTokenIn(log string) string {
	m := setupTokenLine.FindAllStringSubmatch(log, -1)
	if len(m) == 0 {
		return ""
	}
	return m[len(m)-1][1]
}

// newTarget builds the deployment mode the flags selected.
func newTarget(oldRef, newRef string, useDocker bool) (target, error) {
	if useDocker {
		t, err := newDockerTarget(oldRef, newRef)
		if err != nil {
			return nil, err
		}
		return t, nil
	}
	t, err := newStandaloneTarget(oldRef, newRef)
	if err != nil {
		return nil, err
	}
	return t, nil
}

// serverBinary resolves a binary argument absolutely: the server runs with its
// install directory as the working directory.
func serverBinary(arg string) (string, error) {
	bin, err := filepath.Abs(arg)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(bin)
	if err != nil {
		return "", fmt.Errorf("%s is not readable: %w", arg, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory, not a server binary", arg)
	}
	return bin, nil
}

// standaloneTarget rehearses the upgrade the way an owner running the release
// asset does: one install directory, the binary swapped underneath it.
type standaloneTarget struct {
	oldBin  string
	newBin  string
	dir     string  // the single install directory both versions serve from
	running *server // nil once drained
	version string  // "old" | "new" — which binary `running` is
	boots   int     // one log file per launch, so no phase overwrites another's
}

func newStandaloneTarget(oldBin, newBin string) (*standaloneTarget, error) {
	old, err := serverBinary(oldBin)
	if err != nil {
		return nil, err
	}
	next, err := serverBinary(newBin)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "owncord-upgrade-")
	if err != nil {
		return nil, err
	}
	return &standaloneTarget{oldBin: old, newBin: next, dir: dir}, nil
}

func (t *standaloneTarget) start(version string) error {
	bin, err := pickVersion(version, t.oldBin, t.newBin)
	if err != nil {
		return err
	}
	if t.running != nil {
		return fmt.Errorf("start %s: the %s server has not been drained", version, t.version)
	}
	t.boots++
	s, err := start(bin, t.dir, fmt.Sprintf("boot%d-%s.log", t.boots, version), noLiveKitDownload, spawnRestart)
	if err != nil {
		return err
	}
	t.running, t.version = s, version
	return s.waitHealthy(version + " boot")
}

func (t *standaloneTarget) drain() error {
	if t.running == nil {
		return errors.New("drain: no server is running")
	}
	phase := "drain " + t.version
	if err := t.running.drain(phase); err != nil {
		return err
	}
	// Mirrors run()'s phase 3: a listener that outlived the drain, or a stray
	// server holding 8443, would let later phases measure the wrong process.
	if healthy(t.running.bin, t.dir) {
		return t.running.annotate(phase, errors.New("healthcheck still passes after shutdown"))
	}
	t.running = nil
	return nil
}

func (t *standaloneTarget) baseURL() string { return defaultBaseURL }

// installDir is the one directory both versions serve from. The error is always
// nil; it exists for the container leg, which copies.
func (t *standaloneTarget) installDir() (string, error) { return t.dir, nil }

// annotate delegates to the running server; between a drain and the next start
// there is no log, so the phase and cause are returned alone.
func (t *standaloneTarget) annotate(phase string, cause error) error {
	if t.running == nil {
		return fmt.Errorf("%s: %w", phase, cause)
	}
	return t.running.annotate(phase, cause)
}

func (t *standaloneTarget) log() (string, error) {
	if t.running == nil {
		return "", errors.New("no server is running")
	}
	return t.running.log()
}

// archive copies out what the rollback documentation tells an owner to keep:
// the whole data directory plus config.yaml. The database is copied as files,
// so the server must be stopped (a hot copy of SQLite and its WAL is not
// consistent).
func (t *standaloneTarget) archive(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.CopyFS(filepath.Join(dir, "data"), os.DirFS(filepath.Join(t.dir, "data"))); err != nil {
		return fmt.Errorf("archiving the data directory: %w", err)
	}
	if err := tightenModes(filepath.Join(dir, "data")); err != nil {
		return fmt.Errorf("archiving the data directory: %w", err)
	}
	if err := copyFile(filepath.Join(t.dir, "config.yaml"), filepath.Join(dir, "config.yaml"), 0o600); err != nil {
		return fmt.Errorf("archiving config.yaml: %w", err)
	}
	return nil
}

// restore puts the archive back, replacing the live data directory rather than
// merging (post-upgrade files left behind would not be the pre-upgrade state).
// The server must be stopped, as for archive.
func (t *standaloneTarget) restore(dir string) error {
	live := filepath.Join(t.dir, "data")
	if err := os.RemoveAll(live); err != nil {
		return fmt.Errorf("restoring the data directory: %w", err)
	}
	if err := os.CopyFS(live, os.DirFS(filepath.Join(dir, "data"))); err != nil {
		return fmt.Errorf("restoring the data directory: %w", err)
	}
	if err := tightenModes(live); err != nil {
		return fmt.Errorf("restoring the data directory: %w", err)
	}
	if err := copyFile(filepath.Join(dir, "config.yaml"), filepath.Join(t.dir, "config.yaml"), 0o600); err != nil {
		return fmt.Errorf("restoring config.yaml: %w", err)
	}
	return nil
}

// tightenModes narrows a freshly copied tree to owner-only. os.CopyFS creates
// files 0666&^umask and directories 0777&^umask regardless of the source, so a
// copied data/totp.key would come back 0644, and a data directory is a bundle
// of credentials.
func tightenModes(root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		mode := os.FileMode(0o600)
		if d.IsDir() {
			mode = 0o700
		}
		return os.Chmod(path, mode)
	})
}

func (t *standaloneTarget) cleanup() {
	// Kill a server a failed phase left running before removing the directory
	// it has open (Windows refuses otherwise), and wait for the exit since Kill
	// returns before handles are released. waitErr is buffered and unconsumed
	// here, so the receive cannot deadlock against start()'s goroutine.
	if t.running != nil && !t.running.exited {
		_ = t.running.cmd.Process.Kill()
		select {
		case <-t.running.waitErr:
		case <-time.After(drainBudget):
		}
	}
	if t.dir != "" {
		_ = os.RemoveAll(t.dir)
	}
}

// pickVersion resolves the "old"/"new" label to the artefact it names on this
// leg: a binary for standalone, an image for the container.
func pickVersion(version, old, next string) (string, error) {
	switch version {
	case "old":
		return old, nil
	case "new":
		return next, nil
	}
	return "", fmt.Errorf("unknown version %q, want \"old\" or \"new\"", version)
}

// copyFile copies src to dst at mode. 0o600 for the standalone leg, whose
// config.yaml holds the server's secrets; 0o644 for the container leg's
// bind-mounted one, which has to stay readable by uid 65532.
func copyFile(src, dst string, mode os.FileMode) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	//nolint:gosec // G306: the caller picks the mode; see the doc comment
	return os.WriteFile(dst, data, mode)
}
