package db

// staged_restore_paths.go: where a staged restore keeps its files when the
// database path is a symlink; split out of staged_restore.go for its file-size limit.

import (
	"os"
	"path/filepath"
)

// restoreBase is the file every restore file sits beside. A symlinked database path resolves to its
// target, so the swap replaces the real file (SQLite keeps the WAL there too) and the link survives.
// A restore that an older binary staged or half applied beside the link itself is still finished there.
func restoreBase(p string) string {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		real = resolveDangling(p)
	}
	if real == p {
		return p
	}
	if !restoreFilesExist(real) && restoreFilesExist(p) {
		return p
	}
	return real
}

func restoreFilesExist(base string) bool {
	return fileExists(base+restoreMarkerSuffix) || fileExists(base+restoreStagedSuffix) ||
		fileExists(base+restoreStagedSuffix+".tmp") || fileExists(base+restoreRollbackSuffix)
}

// resolveDangling follows a symlink chain whose final target is missing, as it is between the live
// file being moved aside and the staged copy taking its place. It returns p unchanged when p is not
// a link, the chain is too long, or the target's directory cannot be resolved.
func resolveDangling(p string) string {
	cur := p
	for range 40 {
		fi, err := os.Lstat(cur)
		if err != nil || fi.Mode()&os.ModeSymlink == 0 {
			if cur == p {
				return p
			}
			dir, derr := filepath.EvalSymlinks(filepath.Dir(cur))
			if derr != nil {
				return p
			}
			return filepath.Join(dir, filepath.Base(cur))
		}
		target, err := os.Readlink(cur)
		if err != nil {
			return p
		}
		if !filepath.IsAbs(target) {
			// The kernel resolves ".." from the directory the link really lives in.
			dir, derr := filepath.EvalSymlinks(filepath.Dir(cur))
			if derr != nil {
				return p
			}
			target = filepath.Join(dir, target)
		}
		cur = target
	}
	return p
}
