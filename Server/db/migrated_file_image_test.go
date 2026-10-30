package db

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/internal/alphasnap"
)

// Migrating a file database runs every migration, which costs about a second
// per open under the race detector. Tests whose subject is not the migration
// itself start from a byte copy of a file migrated once per test binary.
// The copy differs from a fresh migration only in schema_versions.applied_at.

type migratedFileImage struct {
	once sync.Once
	img  []byte
	err  error
}

var (
	emptyFileImage migratedFileImage
	alphaFileImage migratedFileImage
)

// bytes builds the image on first use: seed lays down the starting file in a
// scratch directory, then it is migrated, checkpointed and closed so the main
// file holds everything.
func (m *migratedFileImage) bytes(seed func(dir string) (string, error)) ([]byte, error) {
	m.once.Do(func() {
		m.img, m.err = buildMigratedFileImage(seed)
	})
	return m.img, m.err
}

//nolint:contextcheck // Migrate takes no context; this runs once per test binary.
func buildMigratedFileImage(seed func(dir string) (string, error)) (img []byte, err error) {
	dir, err := os.MkdirTemp("", "owncord-db-image-")
	if err != nil {
		return nil, fmt.Errorf("scratch dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	path, err := seed(dir)
	if err != nil {
		return nil, fmt.Errorf("seeding image: %w", err)
	}
	database, err := Open(path)
	if err != nil {
		return nil, fmt.Errorf("opening image: %w", err)
	}
	if err := Migrate(database); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("migrating image: %w", err)
	}
	if _, err := database.writer.ExecContext(context.Background(), `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("checkpointing image: %w", err)
	}
	if err := database.Close(); err != nil {
		return nil, fmt.Errorf("closing image: %w", err)
	}
	if st, statErr := os.Stat(path + "-wal"); statErr == nil && st.Size() > 0 {
		return nil, fmt.Errorf("image left a %d-byte -wal behind", st.Size())
	} else if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return nil, fmt.Errorf("stat image -wal: %w", statErr)
	}
	img, err = os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading image: %w", err)
	}
	return img, nil
}

func writeImage(tb testing.TB, m *migratedFileImage, seed func(dir string) (string, error), path string) {
	tb.Helper()
	img, err := m.bytes(seed)
	if err != nil {
		tb.Fatalf("migrated file image: %v", err)
	}
	if err := os.WriteFile(path, img, 0o600); err != nil {
		tb.Fatalf("write migrated image to %s: %v", path, err)
	}
}

// WriteMigratedFileForTest writes a fully migrated, empty database file at
// path, which must not exist yet. Opening it and calling Migrate finds every
// migration applied.
func WriteMigratedFileForTest(tb testing.TB, path string) {
	tb.Helper()
	writeImage(tb, &emptyFileImage, func(dir string) (string, error) {
		return filepath.Join(dir, "empty.db"), nil
	}, path)
}

// writeMigratedAlphaCopy writes the alpha snapshot, migrated to head, as a
// new file in dir and returns its path.
func writeMigratedAlphaCopy(tb testing.TB, dir string) string {
	tb.Helper()
	path := filepath.Join(dir, "alpha-migrated.db")
	writeImage(tb, &alphaFileImage, func(scratch string) (string, error) {
		return alphasnap.Copy(scratch)
	}, path)
	return path
}
