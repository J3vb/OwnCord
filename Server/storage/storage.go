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

// ErrIO marks a Save failure from the server's own filesystem (disk full,
// permissions) so handlers return 5xx, not a 400 blaming the client.
var ErrIO = errors.New("storage io failure")

// blockedMagic maps format names to magic signatures ValidateFileType rejects.
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

// ValidateFileType rejects content whose leading bytes match a blocked magic signature.
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

// New creates a Storage that stores files in dir, creating it if needed.
func New(dir string, maxSizeMB int) (*Storage, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("creating storage dir %s: %w", dir, err)
	}
	return &Storage{dir: dir, maxSizeMB: maxSizeMB}, nil
}

// sanitizeFilename requires a plain basename: no separators, not empty, ".", "..", or leading ".".
func sanitizeFilename(name string) error {
	if name == "" {
		return fmt.Errorf("invalid filename: empty string")
	}
	// filepath.Base strips directories; a difference means a smuggled separator.
	base := filepath.Base(name)
	if base != name {
		return fmt.Errorf("invalid filename %q: must not contain path separators", name)
	}
	if name == "." || name == ".." {
		return fmt.Errorf("invalid filename %q: reserved name", name)
	}
	if strings.HasPrefix(name, ".") {
		return fmt.Errorf("invalid filename %q: must not start with '.'", name)
	}
	if strings.ContainsAny(name, "/\\") {
		return fmt.Errorf("invalid filename %q: must not contain path separators", name)
	}
	return nil
}

// resolvedPath builds the absolute target path and verifies it stays under the storage directory.
func (s *Storage) resolvedPath(name string) (string, error) {
	absDir, err := filepath.Abs(s.dir)
	if err != nil {
		return "", fmt.Errorf("resolving storage dir: %w", err)
	}
	target := filepath.Join(absDir, name)
	if !strings.HasPrefix(target, absDir+string(filepath.Separator)) &&
		target != absDir {
		return "", fmt.Errorf("resolved path %q escapes storage directory", target)
	}
	return target, nil
}

// Save writes r to a file named uuid, first checking the first 8 bytes for a
// blocked type. The caller generates the UUID filename.
func (s *Storage) Save(uuid string, r io.Reader) (int64, error) {
	if s.maxSizeMB < 0 {
		// A negative limit must never reach io.LimitReader (it reads nothing, so every
		// byte would be discarded while Save claims success): fail loudly.
		return 0, fmt.Errorf("invalid storage max size: %d MB", s.maxSizeMB)
	}
	if err := sanitizeFilename(uuid); err != nil {
		return 0, err
	}
	dst, err := s.resolvedPath(uuid)
	if err != nil {
		return 0, err
	}

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
	// Remove the partial file on failure (the orphan sweep is row-driven and never
	// reclaims a file with no row); close first, since Windows cannot delete an open file.
	success := false
	defer func() {
		_ = f.Close()
		if !success {
			if removeErr := os.Remove(dst); removeErr != nil {
				slog.Error("storage: failed to remove partial file", "path", dst, "err", removeErr)
			}
		}
	}()

	maxBytes := int64(s.maxSizeMB) * 1024 * 1024
	full := io.MultiReader(bytes.NewReader(headerSlice), r)
	limited := io.LimitReader(full, maxBytes)
	written, err := io.Copy(f, limited)
	if err != nil {
		// Write-side failures surface as *fs.PathError; read-side ones (client aborted) do not and stay the
		// client's fault.
		if _, ok := errors.AsType[*fs.PathError](err); ok {
			return 0, fmt.Errorf("writing file: %w: %w", ErrIO, err)
		}
		return 0, fmt.Errorf("writing file: %w", err)
	}
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

// thumbDir holds thumbnails named after their originals; List skips it so reconciliation never sees one as a
// stranded upload.
const thumbDir = "thumbs"

// Delete removes the file named uuid and its thumbnail (erasure, retention and
// the orphan sweep all come here). A missing original still removes the
// thumbnail and reports fs.ErrNotExist; an unremovable thumbnail is an error so the caller retries.
func (s *Storage) Delete(uuid string) error {
	if err := sanitizeFilename(uuid); err != nil {
		return err
	}
	dst, err := s.resolvedPath(uuid)
	if err != nil {
		return err
	}
	// The original goes first: SaveThumb checks it after writing, so a concurrent thumbnail is removed by one
	// side.
	err = os.Remove(dst)
	thumb := filepath.Join(filepath.Dir(dst), thumbDir, uuid)
	if thumbErr := os.Remove(thumb); thumbErr != nil && !errors.Is(thumbErr, fs.ErrNotExist) {
		return fmt.Errorf("removing thumbnail: %w: %w", ErrIO, thumbErr)
	}
	return err
}

func (s *Storage) thumbPath(uuid string) (string, error) {
	if err := sanitizeFilename(uuid); err != nil {
		return "", err
	}
	dst, err := s.resolvedPath(uuid)
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(dst), thumbDir, uuid), nil
}

// OpenThumb opens the thumbnail of the original named uuid.
func (s *Storage) OpenThumb(uuid string) (File, error) {
	p, err := s.thumbPath(uuid)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

// SaveThumb stores data as uuid's thumbnail (empty data records that there is
// none). The write is atomic via rename; if the original is gone afterwards the
// thumbnail is removed and fs.ErrNotExist returned.
func (s *Storage) SaveThumb(uuid string, data []byte) error {
	p, err := s.thumbPath(uuid)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("creating thumbnail dir: %w: %w", ErrIO, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("creating thumbnail: %w: %w", ErrIO, err)
	}
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("writing thumbnail: %w: %w", ErrIO, err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("storing thumbnail: %w: %w", ErrIO, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), uuid)); errors.Is(err, fs.ErrNotExist) {
		_ = os.Remove(p)
		return fmt.Errorf("thumbnail of a removed original: %w", fs.ErrNotExist)
	}
	return nil
}

// Entry is one regular file in the storage directory, as List reports it.
type Entry struct {
	Name    string
	ModTime time.Time
	Size    int64
}

// List returns every regular file with its mtime, in name order: the storage
// side of reconciliation (docs/architecture/data-lifecycle.md), since only a
// directory listing finds a file no row names.
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
		out = append(out, Entry{Name: e.Name(), ModTime: info.ModTime(), Size: info.Size()})
	}
	return out, nil
}

// File is what serving a stored blob needs of an opened file. Seeking is
// load-bearing: http.ServeContent needs io.ReadSeeker for range requests, which
// is what makes a remote backend (e.g. S3) the hard part of a storage swap.
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
