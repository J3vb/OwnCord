package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// target is one deployment mode under rehearsal. The fixture and every
// assertion are identical for both; only starting, stopping and swapping a
// version differ, which is the whole reason this seam exists.
type target interface {
	start(version string) error // "old" | "new" — reaches healthy or errors
	drain() error               // graceful stop, exit 0 inside drainBudget
	baseURL() string
	archive(dir string) error // copy the live data dir out, as an owner would
	restore(dir string) error // put it back
	cleanup()                 // release the temp dir or volume; safe on a half-built target
}

var (
	_ target = (*standaloneTarget)(nil)
	_ target = (*dockerTarget)(nil)
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
	return copyFile(filepath.Join(t.dir, "config.yaml"), filepath.Join(dir, "config.yaml"))
}

// restore puts the archive back, replacing the live data directory rather than
// merging into it: a rollback that left post-upgrade files behind would not be
// the pre-upgrade state. Same precondition as archive — THE SERVER MUST BE
// STOPPED, or this is deleting files out from under a running process.
func (t *standaloneTarget) restore(dir string) error {
	live := filepath.Join(t.dir, "data")
	if err := os.RemoveAll(live); err != nil {
		return err
	}
	if err := os.CopyFS(live, os.DirFS(filepath.Join(dir, "data"))); err != nil {
		return fmt.Errorf("restoring the data directory: %w", err)
	}
	return copyFile(filepath.Join(dir, "config.yaml"), filepath.Join(t.dir, "config.yaml"))
}

func (t *standaloneTarget) cleanup() {
	// A failed phase leaves a server running; kill it before removing the
	// directory it has open, or Windows refuses the removal.
	if t.running != nil && !t.running.exited {
		_ = t.running.cmd.Process.Kill()
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

// errDockerLeg is returned by every dockerTarget method until B6-8 Task 5
// builds it. The flag surface accepts -docker already so the workflow and the
// docs can be written against the final command line.
var errDockerLeg = errors.New("the container leg is not implemented yet (B6-8 Task 5)")

// dockerTarget will rehearse the same upgrade as containers on a named volume.
// Image replacement, not container restart: that is the only Docker upgrade
// path OwnCord supports (docs/deployment.md), and the same reason
// Server/scripts/docker-smoke.sh phase 5 replaces rather than restarts.
type dockerTarget struct{}

func newDockerTarget(oldImage, newImage string) (*dockerTarget, error) {
	return nil, fmt.Errorf("%w (asked for %s -> %s)", errDockerLeg, oldImage, newImage)
}

func (t *dockerTarget) start(string) error   { return errDockerLeg }
func (t *dockerTarget) drain() error         { return errDockerLeg }
func (t *dockerTarget) baseURL() string      { return "" }
func (t *dockerTarget) archive(string) error { return errDockerLeg }
func (t *dockerTarget) restore(string) error { return errDockerLeg }
func (t *dockerTarget) cleanup()             {}
