package app

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
)

// restoreFileHold is how long the storage reconciliation pass stands down after
// a restore. A restored database has no rows for the files uploaded after its
// backup, so the pass would remove them; the pre_restore_ safety copy the
// restore left names exactly those files, and going back to it needs them.
const restoreFileHold = 7 * 24 * time.Hour

// restoreHoldActive reports whether a pre_restore_ safety copy in dir was taken
// within restoreFileHold of now, and until when that hold lasts (the newest such
// copy's time plus restoreFileHold). A folder that does not exist holds nothing.
// A folder that cannot be read for any other reason is treated as holding, with
// the error returned, so a folder the server cannot see into never turns into
// permission to remove uploads.
func restoreHoldActive(dir string, now time.Time) (held bool, until time.Time, err error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return false, time.Time{}, nil
	}
	if err != nil {
		return true, time.Time{}, fmt.Errorf("read backup folder: %w", err)
	}
	var newest time.Time
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, admin.PreRestoreBackupPrefix) || filepath.Ext(name) != ".db" {
			continue
		}
		info, infoErr := e.Info()
		if infoErr != nil {
			continue
		}
		if now.Sub(info.ModTime()) < restoreFileHold && info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	if newest.IsZero() {
		return false, time.Time{}, nil
	}
	return true, newest.Add(restoreFileHold), nil
}
