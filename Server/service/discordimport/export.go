package discordimport

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
)

// Reasons an attachment is not copied. Both are counted as skipped.
var (
	// ErrRemoteMedia is a link with a scheme; it is never fetched, since the
	// server would call out to an address the file chose.
	ErrRemoteMedia = errors.New("attachment is a remote link")
	// ErrMediaMissing is a local path the export does not contain.
	ErrMediaMissing = errors.New("attachment file is not in the export")
)

// Zip refusals.
var (
	// ErrUnsafeZip is an entry the importer will not touch: an absolute path, a
	// parent-directory segment, a drive letter, a NUL byte or a symlink.
	ErrUnsafeZip = errors.New("the zip holds an unsafe entry")
	// ErrZipTooLarge is a zip over the entry-count or uncompressed-size cap.
	ErrZipTooLarge = errors.New("the zip is larger than the import allows")
)

// Defaults for ZipLimits.
const (
	DefaultMaxZipEntries = 100_000
	DefaultMaxZipBytes   = 32 << 30
)

// ZipLimits bound what a zip may expand to. Zero fields take the defaults.
type ZipLimits struct {
	MaxEntries           int
	MaxUncompressedBytes int64
}

// Media is an opened attachment file.
type Media struct {
	Reader io.ReadCloser
	// Size is the declared size in bytes, used to reserve space. The reader
	// still enforces its own limits.
	Size int64
}

// Export is an opened export: the JSON document and the local files it names.
type Export interface {
	// OpenJSON opens the export's JSON document.
	OpenJSON() (io.ReadCloser, error)
	// OpenMedia opens the file an attachment URL names, or returns
	// ErrRemoteMedia or ErrMediaMissing.
	OpenMedia(ref string) (Media, error)
	Close() error
}

// OpenFile opens a .zip or .json export by its extension.
func OpenFile(p string, lim ZipLimits) (Export, error) {
	switch strings.ToLower(path.Ext(strings.ReplaceAll(p, "\\", "/"))) {
	case ".json":
		return jsonExport{path: p}, nil
	case ".zip":
		f, err := os.Open(p) //nolint:gosec // G304: the path is the admin's chosen upload, opened read-only
		if err != nil {
			return nil, fmt.Errorf("opening export: %w", err)
		}
		st, err := f.Stat()
		if err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("opening export: %w", err)
		}
		z, err := NewZipExport(f, st.Size(), lim)
		if err != nil {
			_ = f.Close()
			return nil, err
		}
		z.closer = f
		return z, nil
	}
	return nil, fmt.Errorf("%w: expected a .json or .zip file", ErrBadExport)
}

// jsonExport is a bare .json file: no media travels with it.
type jsonExport struct{ path string }

func (j jsonExport) OpenJSON() (io.ReadCloser, error) {
	f, err := os.Open(j.path)
	if err != nil {
		return nil, fmt.Errorf("opening export: %w", err)
	}
	return f, nil
}

func (j jsonExport) OpenMedia(ref string) (Media, error) {
	if _, err := localCandidates(ref); err != nil {
		return Media{}, err
	}
	return Media{}, ErrMediaMissing
}

func (j jsonExport) Close() error { return nil }

// ZipExport reads an export from a zip. Nothing is extracted to disk: media is
// streamed from the archive straight into storage.
type ZipExport struct {
	zr     *zip.Reader
	json   *zip.File
	jsonAt string
	files  map[string]*zip.File
	budget *byteBudget
	closer io.Closer
}

// byteBudget is the uncompressed bytes the zip may still yield, checked on every
// read so an understated header cannot slip past the cap.
type byteBudget struct{ remaining int64 }

// NewZipExport validates every entry of the zip and indexes it. It refuses the
// whole archive on the first unsafe entry or when a cap is exceeded.
func NewZipExport(ra io.ReaderAt, size int64, lim ZipLimits) (*ZipExport, error) {
	if lim.MaxEntries <= 0 {
		lim.MaxEntries = DefaultMaxZipEntries
	}
	if lim.MaxUncompressedBytes <= 0 {
		lim.MaxUncompressedBytes = DefaultMaxZipBytes
	}
	zr, err := zip.NewReader(ra, size)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrBadExport, err)
	}
	if len(zr.File) > lim.MaxEntries {
		return nil, fmt.Errorf("%w: %d entries, the limit is %d", ErrZipTooLarge, len(zr.File), lim.MaxEntries)
	}
	maxBytes := uint64(lim.MaxUncompressedBytes) //nolint:gosec // G115: made positive above
	z := &ZipExport{zr: zr, files: make(map[string]*zip.File, len(zr.File)), budget: &byteBudget{remaining: lim.MaxUncompressedBytes}}
	var total uint64
	var roots, nested []string
	for _, f := range zr.File {
		name, err := cleanZipName(f.Name)
		if err != nil {
			return nil, err
		}
		if f.Mode()&fs.ModeSymlink != 0 {
			return nil, fmt.Errorf("%w: a symlink", ErrUnsafeZip)
		}
		if f.FileInfo().IsDir() || strings.HasSuffix(f.Name, "/") {
			continue
		}
		total += f.UncompressedSize64
		if total < f.UncompressedSize64 || total > maxBytes {
			return nil, fmt.Errorf("%w: more than %d bytes uncompressed", ErrZipTooLarge, lim.MaxUncompressedBytes)
		}
		z.files[name] = f
		if isExportJSON(name) {
			if path.Dir(name) == "." {
				roots = append(roots, name)
			} else {
				nested = append(nested, name)
			}
		}
	}
	// A .json inside a folder is a downloaded attachment, unless nothing sits at
	// the root (a zipped folder), when the single nested one is the document.
	candidates := roots
	if len(candidates) == 0 {
		candidates = nested
	}
	switch len(candidates) {
	case 0:
		return nil, fmt.Errorf("%w: the zip holds no .json file", ErrBadExport)
	case 1:
		z.json, z.jsonAt = z.files[candidates[0]], path.Dir(candidates[0])
	default:
		return nil, fmt.Errorf("%w: the zip holds more than one .json file", ErrBadExport)
	}
	return z, nil
}

// isExportJSON picks the export document: a .json that is not archiver debris.
func isExportJSON(name string) bool {
	if !strings.HasSuffix(strings.ToLower(name), ".json") {
		return false
	}
	base := path.Base(name)
	return !strings.HasPrefix(name, "__MACOSX/") && !strings.HasPrefix(base, "._")
}

var driveLetter = regexp.MustCompile(`^[A-Za-z]:`)

// cleanZipName validates an entry name and returns it with '/' separators.
func cleanZipName(raw string) (string, error) {
	if strings.ContainsRune(raw, 0) {
		return "", fmt.Errorf("%w: a NUL byte in a name", ErrUnsafeZip)
	}
	n := strings.ReplaceAll(raw, "\\", "/")
	if strings.HasPrefix(n, "/") || driveLetter.MatchString(n) {
		return "", fmt.Errorf("%w: an absolute path", ErrUnsafeZip)
	}
	for seg := range strings.SplitSeq(n, "/") {
		if seg == ".." {
			return "", fmt.Errorf("%w: a parent-directory segment", ErrUnsafeZip)
		}
	}
	return path.Clean(n), nil
}

func (z *ZipExport) OpenJSON() (io.ReadCloser, error) { return z.open(z.json) }

func (z *ZipExport) open(f *zip.File) (io.ReadCloser, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("reading the zip: %w", err)
	}
	return &budgetReader{rc: rc, budget: z.budget}, nil
}

// OpenMedia finds an attachment by the path its URL holds, relative to the zip
// root or to the folder the JSON sits in.
func (z *ZipExport) OpenMedia(ref string) (Media, error) {
	cands, err := localCandidates(ref)
	if err != nil {
		return Media{}, err
	}
	for _, c := range cands {
		for _, name := range []string{c, path.Join(z.jsonAt, c)} {
			if f, ok := z.files[name]; ok && f != z.json {
				rc, err := z.open(f)
				if err != nil {
					return Media{}, err
				}
				return Media{Reader: rc, Size: int64(min(f.UncompressedSize64, 1<<62))}, nil
			}
		}
	}
	return Media{}, ErrMediaMissing
}

func (z *ZipExport) Close() error {
	if z.closer != nil {
		return z.closer.Close()
	}
	return nil
}

// localCandidates turns an attachment URL into the zip paths it could mean:
// ErrRemoteMedia for anything with a scheme or a host, ErrMediaMissing for an
// empty or escaping path.
func localCandidates(ref string) (candidates []string, err error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, ErrMediaMissing
	}
	if strings.HasPrefix(ref, "//") || driveLetter.MatchString(ref) {
		return nil, ErrRemoteMedia
	}
	if u, perr := url.Parse(ref); perr == nil && u.Scheme != "" {
		return nil, ErrRemoteMedia
	}
	raws := []string{ref}
	if un, uerr := url.PathUnescape(ref); uerr == nil && un != ref {
		raws = append(raws, un)
	}
	for _, r := range raws {
		n := strings.ReplaceAll(r, "\\", "/")
		if strings.HasPrefix(n, "/") {
			continue
		}
		bad := false
		for seg := range strings.SplitSeq(n, "/") {
			if seg == ".." {
				bad = true
			}
		}
		if bad {
			continue
		}
		candidates = append(candidates, path.Clean(n))
	}
	if len(candidates) == 0 {
		return nil, ErrMediaMissing
	}
	return candidates, nil
}

type budgetReader struct {
	rc     io.ReadCloser
	budget *byteBudget
}

func (b *budgetReader) Read(p []byte) (int, error) {
	if b.budget.remaining <= 0 {
		// Spent. An entry that ended exactly on the cap is fine; one with a byte
		// more is not.
		var probe [1]byte
		n, err := b.rc.Read(probe[:])
		if n > 0 {
			return 0, ErrZipTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > b.budget.remaining {
		p = p[:b.budget.remaining]
	}
	n, err := b.rc.Read(p)
	b.budget.remaining -= int64(n)
	return n, err
}

func (b *budgetReader) Close() error { return b.rc.Close() }
