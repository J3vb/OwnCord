// Package storage handles file upload validation and storage for the OwnCord server.
package storage

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// blockedMagic maps format names to their magic byte signatures. Files whose
// leading bytes match any entry are rejected by ValidateFileType.
var blockedMagic = []struct {
	name  string
	magic []byte
}{
	{"PE executable", []byte("MZ")},             // Windows .exe / .dll
	{"ELF binary", []byte("\x7fELF")},            // Linux binaries
	{"Mach-O 64", []byte("\xcf\xfa\xed\xfe")},   // macOS 64-bit
	{"Mach-O 32", []byte("\xce\xfa\xed\xfe")},   // macOS 32-bit
	{"shell script", []byte("#!")},               // Shebang scripts (.sh, .py, etc.)
}

// ValidateFileType checks the first few bytes of a file against known blocked
// magic bytes. It returns an error if the content matches a blocked file type,
// or nil if the content is allowed.
func ValidateFileType(header []byte) error {
	for _, blocked := range blockedMagic {
		if len(header) >= len(blocked.magic) && bytes.Equal(header[:len(blocked.magic)], blocked.magic) {
			return fmt.Errorf("blocked file type: %s", blocked.name)
		}
	}
	return nil
}

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

// sanitizeFilename validates that name is safe to use as a filename inside the
// storage directory.  It must be a plain basename with no path separators, must
// not be empty, ".", or "..", and must not start with ".".
func sanitizeFilename(name string) error {
	if name == "" {
		return fmt.Errorf("invalid filename: empty string")
	}
	// filepath.Base strips any directory component; if it differs from the
	// original input the caller smuggled a path separator.
	base := filepath.Base(name)
	if base != name {
		return fmt.Errorf("invalid filename %q: must not contain path separators", name)
	}
	// Reject "." and ".." explicitly.
	if name == "." || name == ".." {
		return fmt.Errorf("invalid filename %q: reserved name", name)
	}
	// Reject filenames starting with "." (hidden/config files).
	if strings.HasPrefix(name, ".") {
		return fmt.Errorf("invalid filename %q: must not start with '.'", name)
	}
	// Explicitly reject embedded separators on both Unix and Windows.
	if strings.ContainsAny(name, "/\\") {
		return fmt.Errorf("invalid filename %q: must not contain path separators", name)
	}
	return nil
}

// resolvedPath builds the absolute target path and verifies it stays within
// the storage directory.
func (s *Storage) resolvedPath(name string) (string, error) {
	absDir, err := filepath.Abs(s.dir)
	if err != nil {
		return "", fmt.Errorf("resolving storage dir: %w", err)
	}
	target := filepath.Join(absDir, name)
	// Ensure the joined path is still under absDir.
	if !strings.HasPrefix(target, absDir+string(filepath.Separator)) &&
		target != absDir {
		return "", fmt.Errorf("resolved path %q escapes storage directory", target)
	}
	return target, nil
}

// Save writes the content from r to a file named by uuid within the storage dir.
// It reads the first 8 bytes to validate the file type (rejecting executables
// and scripts) before writing the full content to disk.
// The caller is responsible for generating a UUID filename.
func (s *Storage) Save(uuid string, r io.Reader) error {
	if err := sanitizeFilename(uuid); err != nil {
		return err
	}
	dst, err := s.resolvedPath(uuid)
	if err != nil {
		return err
	}

	// Read the first 8 bytes to check magic bytes without consuming the stream.
	var header [8]byte
	n, err := io.ReadFull(r, header[:])
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return fmt.Errorf("reading file header: %w", err)
	}
	headerSlice := header[:n]

	if err := ValidateFileType(headerSlice); err != nil {
		return err
	}

	f, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("creating file %s: %w", dst, err)
	}
	defer f.Close() //nolint:errcheck

	// Reconstruct the full stream: header bytes we already read + remainder.
	maxBytes := int64(s.maxSizeMB) * 1024 * 1024
	full := io.MultiReader(bytes.NewReader(headerSlice), r)
	written, err := io.Copy(f, io.LimitReader(full, maxBytes+1))
	if err != nil {
		return fmt.Errorf("writing file: %w", err)
	}
	if written > maxBytes {
		// File exceeds limit — remove the partial write and reject.
		_ = f.Close()
		_ = os.Remove(dst)
		return fmt.Errorf("file exceeds maximum size of %d MB", s.maxSizeMB)
	}
	return nil
}

// Delete removes the file named uuid from the storage dir.
func (s *Storage) Delete(uuid string) error {
	if err := sanitizeFilename(uuid); err != nil {
		return err
	}
	dst, err := s.resolvedPath(uuid)
	if err != nil {
		return err
	}
	return os.Remove(dst)
}

// Open opens the file named uuid for reading.
func (s *Storage) Open(uuid string) (*os.File, error) {
	if err := sanitizeFilename(uuid); err != nil {
		return nil, err
	}
	dst, err := s.resolvedPath(uuid)
	if err != nil {
		return nil, err
	}
	return os.Open(dst)
}
