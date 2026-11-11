package app

import (
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
// within restoreFileHold of now. A missing or unreadable dir holds nothing.
func restoreHoldActive(dir string, now time.Time) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, admin.PreRestoreBackupPrefix) || filepath.Ext(name) != ".db" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) < restoreFileHold {
			return true
		}
	}
	return false
}
