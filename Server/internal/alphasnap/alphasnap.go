// Package alphasnap hands tests a private copy of the committed alpha-shaped
// database snapshot, Server/testdata/snapshots/v1.2.0-alpha.4.sqlite — the
// B3-7 dataset that HP-4's drills and the B4-9..B4-11 destructive tests run
// against (docs/architecture/data-lifecycle.md, "Drill protocol").
//
// The tracked file is never opened for writing and never opened by SQLite
// through this package: every consumer gets a byte copy in a directory it
// owns, so the source cannot gain a -wal/-shm sidecar or change a byte. The
// package imports neither testing nor db on purpose — it resolves a path and
// copies bytes, so any package's tests can use it without a db import and
// nothing here links into the server binary.
package alphasnap

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// Name is the snapshot's file name. The README beside it records its shape
// and the rule that it is regenerated only deliberately.
const Name = "v1.2.0-alpha.4.sqlite"

// relPath is the snapshot's location under the Server module root.
var relPath = filepath.Join("testdata", "snapshots", Name)

// Path returns the absolute path of the tracked snapshot.
//
// It is resolved from this source file's compiled-in location first, which
// works from any package's test working directory. Under -trimpath that
// location is not a real path, so the fallback walks up from the working
// directory to the module root (the directory holding go.mod) — every `go
// test` runs inside the module.
func Path() (string, error) {
	if _, self, _, ok := runtime.Caller(0); ok {
		// self = <root>/internal/alphasnap/alphasnap.go
		root := filepath.Dir(filepath.Dir(filepath.Dir(self)))
		p := filepath.Join(root, relPath)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}

	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("alphasnap: resolving working directory: %w", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			p := filepath.Join(dir, relPath)
			if _, err := os.Stat(p); err != nil {
				return "", fmt.Errorf("alphasnap: snapshot not found at %s: %w", p, err)
			}
			return p, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("alphasnap: no go.mod above the working directory")
		}
		dir = parent
	}
}

// Copy writes a private copy of the snapshot into dir, which must already
// exist (a test's t.TempDir()), and returns the copy's path. Each call makes
// a new file, so a test may hold several copies in one directory.
func Copy(dir string) (string, error) {
	src, err := Path()
	if err != nil {
		return "", err
	}
	in, err := os.Open(src) //nolint:gosec // G304: the path is resolved from this file's own location and a fixed name, never from input
	if err != nil {
		return "", fmt.Errorf("alphasnap: opening snapshot: %w", err)
	}
	defer func() { _ = in.Close() }()

	out, err := os.CreateTemp(dir, "alpha-*.sqlite")
	if err != nil {
		return "", fmt.Errorf("alphasnap: creating copy: %w", err)
	}
	dst := out.Name()
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return "", fmt.Errorf("alphasnap: copying snapshot: %w", err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return "", fmt.Errorf("alphasnap: closing copy: %w", err)
	}
	return dst, nil
}
