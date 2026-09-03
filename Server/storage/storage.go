// Package storage handles file upload validation and storage for the OwnCord server.
package storage

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrIO marks a Save failure caused by the server's own filesystem — disk
// full, permissions, a read-only mount — as opposed to the uploaded content
// being invalid. Handlers use it to return a 5xx instead of blaming the
// client with a 400, so infrastructure failures are distinguishable in any
// status-class dashboard.
var ErrIO = errors.New("storage io failure")

// blockedMagic maps format names to their magic byte signatures. Files whose
// leading bytes match any entry are rejected by ValidateFileType.
var blockedMagic = []struct {
	name  string
	magic []byte
}{
	{"PE executable", []byte("MZ")},                      // Windows .exe / .dll
	{"ELF binary", []byte("\x7fELF")},                    // Linux binaries
	{"Mach-O 64", []byte("\xcf\xfa\xed\xfe")},            // macOS 64-bit
	{"Mach-O 32", []byte("\xce\xfa\xed\xfe")},            // macOS 32-bit
	{"shell script", []byte("#!")},                       // Shebang scripts (.sh, .py, etc.)
	{"Java class", []byte("\xca\xfe\xba\xbe")},           // .class files
	{"OLE2 document", []byte("\xd0\xcf\x11\xe0")},        // .doc/.xls with macros
	{"WebAssembly", []byte("\x00asm")},                   // .wasm modules
	{"Windows shortcut", []byte{0x4c, 0x00, 0x00, 0x00}}, // .lnk files
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
	if err := os.MkdirAll(dir, 0o750); err != nil {
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
func (s *Storage) Save(uuid string, r io.Reader) (int64, error) {
	if err := sanitizeFilename(uuid); err != nil {
		return 0, err
	}
	dst, err := s.resolvedPath(uuid)
	if err != nil {
		return 0, err
	}

	// Read the first 8 bytes to check magic bytes without consuming the stream.
	var header [8]byte
	n, err := io.ReadFull(r, header[:])
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return 0, fmt.Errorf("reading file header: %w", err)
	}
	headerSlice := header[:n]

	if err := ValidateFileType(headerSlice); err != nil {
		return 0, err
	}

	f, err := os.Create(dst)
	if err != nil {
		return 0, fmt.Errorf("creating file %s: %w: %w", dst, ErrIO, err)
	}
	// Any failure after this point must remove the partial file: the orphan
	// sweep is DB-row-driven, so a file without a DB row is never reclaimed.
	// Close before remove — Windows cannot delete an open file.
	success := false
	defer func() {
		_ = f.Close()
		if !success {
			if removeErr := os.Remove(dst); removeErr != nil {
				slog.Error("storage: failed to remove partial file", "path", dst, "err", removeErr)
			}
		}
	}()

	// Reconstruct the full stream: header bytes we already read + remainder.
	maxBytes := int64(s.maxSizeMB) * 1024 * 1024
	full := io.MultiReader(bytes.NewReader(headerSlice), r)
	limited := io.LimitReader(full, maxBytes)
	written, err := io.Copy(f, limited)
	if err != nil {
		// Write-side failures surface as *fs.PathError (File.Write wraps
		// them); read-side failures (client aborted mid-upload) do not, and
		// those stay the client's fault.
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) {
			return 0, fmt.Errorf("writing file: %w: %w", ErrIO, err)
		}
		return 0, fmt.Errorf("writing file: %w", err)
	}
	// Probe for one more byte to detect if the file exceeds the limit.
	if written == maxBytes {
		var probe [1]byte
		if n, _ := full.Read(probe[:]); n > 0 {
			return 0, fmt.Errorf("file exceeds maximum size of %d MB", s.maxSizeMB)
		}
	}
	if syncErr := f.Sync(); syncErr != nil {
		return 0, fmt.Errorf("syncing file %s: %w: %w", dst, ErrIO, syncErr)
	}
	success = true
	return written, nil
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

// Entry is one regular file in the storage directory, as List reports it.
type Entry struct {
	Name    string
	ModTime time.Time
}

// List returns every regular file in the storage directory with its
// modification time, in name order. Subdirectories and anything that is
// not a plain file are skipped. It is the storage side of the reconciliation
// pass (docs/architecture/data-lifecycle.md, O3 A3): a file no database row
// names is stranded, and only a directory listing can find it.
func (s *Storage) List() ([]Entry, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("listing storage dir: %w: %w", ErrIO, err)
	}
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue // removed between the listing and the stat
			}
			return nil, fmt.Errorf("stat %s: %w: %w", e.Name(), ErrIO, err)
		}
		out = append(out, Entry{Name: e.Name(), ModTime: info.ModTime()})
	}
	return out, nil
}

// File is what serving a stored blob requires of an opened file. Seeking is
// load-bearing, not incidental: both serve paths hand the file to
// http.ServeContent, which needs io.ReadSeeker for range requests — the
// exact capability that makes a remote backend (e.g. S3) the hard part of
// any future storage swap. Stat provides size and modtime the same way.
// *os.File satisfies it.
type File interface {
	io.Reader
	io.Seeker
	io.Closer
	Stat() (os.FileInfo, error)
}

// Open opens the file named uuid for reading.
func (s *Storage) Open(uuid string) (File, error) {
	if err := sanitizeFilename(uuid); err != nil {
		return nil, err
	}
	dst, err := s.resolvedPath(uuid)
	if err != nil {
		return nil, err
	}
	return os.Open(dst)
}
