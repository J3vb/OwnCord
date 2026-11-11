// Package alphasnap hands tests a private copy of the committed alpha-shaped
// database snapshot (docs/architecture/data-lifecycle.md, "Drill protocol").
package alphasnap

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// Name is the snapshot's file name.
const Name = "v1.2.0-alpha.4.sqlite"

var relPath = filepath.Join("testdata", "snapshots", Name)

// Path returns the absolute path of the tracked snapshot, falling back to a
// walk up to the directory holding go.mod when -trimpath makes the compiled-in
// source location unusable.
func Path() (string, error) {
	if _, self, _, ok := runtime.Caller(0); ok {
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

// Copy writes a private copy of the snapshot into the existing directory dir
// and returns its path; each call makes a new file.
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
