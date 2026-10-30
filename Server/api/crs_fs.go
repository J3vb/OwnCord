package api

import (
	"io/fs"
	"strings"
)

// slashFS wraps an fs.FS so OS-specific separators in path arguments become the
// forward slashes io/fs and embed.FS require. It keeps the embedded OWASP CRS
// loadable on Windows: coraza's seclang parser resolves Include globs through
// path/filepath, which on Windows rewrites slashes to backslashes (e.g.
// "@owasp_crs\\REQUEST-901-INITIALIZATION.conf"); embed.FS rejects such names
// and CRS initialization fails outright. Normalizing here fixes it on every OS
// without patching coraza, and is a no-op where the separator is already "/".
type slashFS struct {
	inner fs.FS
}

func toSlashPath(name string) string {
	return strings.ReplaceAll(name, "\\", "/")
}

func (s slashFS) Open(name string) (fs.File, error) {
	return s.inner.Open(toSlashPath(name))
}

// ReadFile satisfies fs.ReadFileFS; coraza loads each included rule file through
// it.
func (s slashFS) ReadFile(name string) ([]byte, error) {
	return fs.ReadFile(s.inner, toSlashPath(name))
}

func (s slashFS) ReadDir(name string) ([]fs.DirEntry, error) {
	return fs.ReadDir(s.inner, toSlashPath(name))
}

// Glob satisfies fs.GlobFS; coraza uses fs.Glob to expand "Include" patterns
// like "@owasp_crs/*.conf". The delegate returns forward-slash matches.
func (s slashFS) Glob(pattern string) ([]string, error) {
	return fs.Glob(s.inner, toSlashPath(pattern))
}
