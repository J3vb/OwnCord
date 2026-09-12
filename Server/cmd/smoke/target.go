package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	// root, data/ beneath. Part of the seam rather than a field the phases
	// reach into, because the container leg's install is not this harness's
	// own temp directory.
	//
	// It returns an error because for the container leg it is not a getter:
	// it copies the live state out of the container, and a copy that failed
	// would hand back the PREVIOUS phase's state. Every assertion would then
	// pass over bytes the phase never read, which is the one failure mode
	// worth failing the run for.
	installDir() (string, error)
	archive(dir string) error // copy the live data dir out, as an owner would
	restore(dir string) error // put it back
	// annotate attaches the running server's log tail to a phase failure, the
	// way server.annotate does for the plain smoke. Phases assert through the
	// API, so without this a failed assertion arrives with no sight of what
	// the server said while failing it.
	annotate(phase string, cause error) error
	cleanup() // release the temp dir or volume; safe on a half-built target
}

var (
	_ target = (*standaloneTarget)(nil)
	_ target = (*dockerTarget)(nil) // the container leg, in docker.go
)

// defaultBaseURL is where the default config.yaml puts the server: port 8443,
// self-signed TLS, and admin_allowed_cidrs already covering 127.0.0.0/8, so
// loopback is both reachable and admin-authorised without editing the file
// whose hash the rehearsal compares.
const defaultBaseURL = "https://127.0.0.1:8443"

// noLiveKitDownload goes into the environment of every server this rehearsal
// launches. A cold boot otherwise fetches the ~40 MB LiveKit server into the
// data directory, which would land inside the archive and turn the
// byte-for-byte state comparison into a race against a download.
// OWNCORD_<SECTION>_<KEY> overrides a config key without rewriting config.yaml,
// so the file under test is untouched.
const noLiveKitDownload = "OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT=false"

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

// serverBinary resolves a binary argument absolutely. The server runs with its
// install directory as the working directory, so a relative path would resolve
// against that instead of against the caller's.
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
	bin, err := t.binary(version)
	if err != nil {
		return err
	}
	if t.running != nil {
		return fmt.Errorf("start %s: the %s server has not been drained", version, t.version)
	}
	t.boots++
	s, err := start(bin, t.dir, fmt.Sprintf("boot%d-%s.log", t.boots, version), noLiveKitDownload)
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
	// Mirrors run()'s phase 3. Without this, a listener that outlived the drain
	// — or a stray server from an earlier phase still holding 8443 — would let
	// every later phase measure the wrong process and still pass.
	if healthy(t.running.bin, t.dir) {
		return t.running.annotate(phase, errors.New("healthcheck still passes after shutdown"))
	}
	t.running = nil
	return nil
}

func (t *standaloneTarget) baseURL() string { return defaultBaseURL }

// installDir is the one directory both versions serve from: the upgrade is a
// binary swap underneath it, so it is also what the state captures read. The
// error is always nil here — nothing has to be copied to answer — and it
// exists for the container leg, which does.
func (t *standaloneTarget) installDir() (string, error) { return t.dir, nil }

// annotate delegates to the running server. Between a drain and the next
// start there is no log to attach, so the phase and cause are returned alone
// rather than dereferencing a nil server inside the harness that is already
// reporting a failure.
func (t *standaloneTarget) annotate(phase string, cause error) error {
	if t.running == nil {
		return fmt.Errorf("%s: %w", phase, cause)
	}
	return t.running.annotate(phase, cause)
}

// archive copies out exactly what the rollback documentation will tell an owner
// to keep: the whole data directory (database, uploads, backups, the three
// on-disk key files) plus config.yaml. The database is copied as files rather
// than through the backup API, so THE SERVER MUST BE STOPPED — a hot copy of a
// live SQLite database and its WAL is not a consistent snapshot.
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
	if err := copyFile(filepath.Join(t.dir, "config.yaml"), filepath.Join(dir, "config.yaml")); err != nil {
		return fmt.Errorf("archiving config.yaml: %w", err)
	}
	return nil
}

// restore puts the archive back, replacing the live data directory rather than
// merging into it: a rollback that left post-upgrade files behind would not be
// the pre-upgrade state. Same precondition as archive — THE SERVER MUST BE
// STOPPED, or this is deleting files out from under a running process.
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
	if err := copyFile(filepath.Join(dir, "config.yaml"), filepath.Join(t.dir, "config.yaml")); err != nil {
		return fmt.Errorf("restoring config.yaml: %w", err)
	}
	return nil
}

// tightenModes narrows a freshly copied tree to owner-only. os.CopyFS creates
// files 0666&^umask and directories 0777&^umask regardless of the source, so on
// Linux a copied data/totp.key comes back 0644 — and a data directory is a
// bundle of credentials (totp.key, erasure.key, push_vapid.key, the database,
// every upload). The rollback recipe the docs will give owners is this copy, so
// it must not be the step that world-reads their keys.
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
	// A failed phase leaves a server running; kill it before removing the
	// directory it has open, or Windows refuses the removal. Kill returns
	// before the process is reaped and its handles released, so wait for the
	// exit as well — otherwise this is the very race the kill is here to avoid.
	// waitErr is buffered and nobody has consumed it on this branch (exited is
	// false), so the receive cannot deadlock against the goroutine in start().
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

func (t *standaloneTarget) binary(version string) (string, error) {
	switch version {
	case "old":
		return t.oldBin, nil
	case "new":
		return t.newBin, nil
	}
	return "", fmt.Errorf("unknown version %q, want \"old\" or \"new\"", version)
}

// copyFile is 0o600 because config.yaml holds the server's secrets.
func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o600)
}
