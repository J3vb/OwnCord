// Package storage handles file upload validation and storage for the OwnCord server.
// Full implementation follows in Phase 4 (Real-Time Chat Features).
package storage

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Storage manages file uploads on disk.
type Storage struct {
	dir       string
	maxSizeMB int
}

// New creates a Storage instance that stores files in dir.
// dir is created if it does not exist.
func New(dir string, maxSizeMB int) (*Storage, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("creating storage dir %s: %w", dir, err)
	}
	return &Storage{dir: dir, maxSizeMB: maxSizeMB}, nil
}

// Save writes the content from r to a file named by uuid within the storage dir.
// The caller is responsible for generating a UUID filename.
func (s *Storage) Save(uuid string, r io.Reader) error {
	dst := filepath.Join(s.dir, uuid)
	f, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("creating file %s: %w", dst, err)
	}
	defer f.Close()

	maxBytes := int64(s.maxSizeMB) * 1024 * 1024
	if _, err := io.Copy(f, io.LimitReader(r, maxBytes+1)); err != nil {
		return fmt.Errorf("writing file: %w", err)
	}
	return nil
}

// Delete removes the file named uuid from the storage dir.
func (s *Storage) Delete(uuid string) error {
	return os.Remove(filepath.Join(s.dir, uuid))
}

// Open opens the file named uuid for reading.
func (s *Storage) Open(uuid string) (*os.File, error) {
	return os.Open(filepath.Join(s.dir, uuid))
}
