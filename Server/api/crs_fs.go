package api

import (
	"io/fs"
	"strings"
)

// slashFS wraps an fs.FS so that path arguments arriving with OS-specific
// separators are normalized to the forward slashes that io/fs and embed.FS
// require.
//
// This exists to keep the embedded OWASP CRS ruleset loadable on Windows.
// coraza's seclang parser resolves Include globs through path/filepath: for
// each glob match it does filepath.Join(currentDir, match) and
// filepath.Dir(...) (see coraza/internal/seclang parser FromFile). On Windows
// filepath.Join/Clean rewrite the forward slashes to backslashes, so the names
// coraza then feeds back into fs.ReadFile look like
// "@owasp_crs\\REQUEST-901-INITIALIZATION.conf". The embedded CRS filesystem is
// an embed.FS, which is always forward-slash and rejects such a name, so CRS
// engine initialization fails outright on Windows (every CRS rule file under a
// subdirectory is unreachable). Normalizing here fixes it on every OS without
// patching coraza or the ruleset module, and is a no-op on platforms whose
// separator is already "/".
type slashFS struct {
	inner fs.FS
}

func toSlashPath(name string) string {
	return strings.ReplaceAll(name, "\\", "/")
}

func (s slashFS) Open(name string) (fs.File, error) {
	return s.inner.Open(toSlashPath(name))
}

// ReadFile satisfies fs.ReadFileFS; coraza uses fs.ReadFile to load each
// included rule file, which dispatches here when the wrapper is the root FS.
func (s slashFS) ReadFile(name string) ([]byte, error) {
	return fs.ReadFile(s.inner, toSlashPath(name))
}

// ReadDir satisfies fs.ReadDirFS for completeness (glob traversal fallbacks).
func (s slashFS) ReadDir(name string) ([]fs.DirEntry, error) {
	return fs.ReadDir(s.inner, toSlashPath(name))
}

// Glob satisfies fs.GlobFS; coraza uses fs.Glob to expand "Include" patterns
// like "@owasp_crs/*.conf". The delegate returns forward-slash matches.
func (s slashFS) Glob(pattern string) ([]string, error) {
	return fs.Glob(s.inner, toSlashPath(pattern))
}
