package diskutil

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
)

// SameVolume reports whether a and b are on the same filesystem (the same volume on Windows). A path that
// does not exist yet is judged by its nearest existing parent, as a folder made later would land there. An
// error means the answer is unknown; callers must not read it as "different disks".
func SameVolume(a, b string) (bool, error) {
	return sameVolume(a, b, volumeProbe{id: volumeID, parent: filepath.Dir})
}

// volumeProbe is the part of the answer the operating system gives, so a test can stand in for it. id names
// the volume of an existing path and wraps fs.ErrNotExist for a missing one; parent steps one folder up.
type volumeProbe struct {
	id     func(path string) (string, error)
	parent func(path string) string
}

func sameVolume(a, b string, p volumeProbe) (bool, error) {
	ida, err := p.nearestID(a)
	if err != nil {
		return false, err
	}
	idb, err := p.nearestID(b)
	if err != nil {
		return false, err
	}
	return ida == idb, nil
}

// nearestID names the volume of path, or of its closest existing parent.
func (p volumeProbe) nearestID(path string) (string, error) {
	for cur := path; ; {
		id, err := p.id(cur)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("diskutil: volume of %s: %w", cur, err)
		}
		next := p.parent(cur)
		if next == cur || next == "" || next == "." {
			return "", fmt.Errorf("diskutil: volume of %s: no existing parent: %w", path, err)
		}
		cur = next
	}
}
