package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/stackutil"
)

// bootMarkerRelPath is the boot marker under the data directory, rewritten at a
// clean close so the next start can tell how the last run ended.
const bootMarkerRelPath = "boot.json"

// bootMarkerFile is the on-disk record; Clean is false while a run is in
// progress.
type bootMarkerFile struct {
	StartedAt   time.Time `json:"started_at"`
	LastPanicAt time.Time `json:"last_panic_at,omitzero"`
	Clean       bool      `json:"clean"`
}

// bootMarker is the running process's handle on the marker file.
type bootMarker struct {
	path string
	file bootMarkerFile
	// unreported is an unclean previous exit not yet shown on the attention
	// panel; close carries it forward instead of writing clean.
	unreported *bootMarkerFile

	mu sync.Mutex
}

// readBootMarker reads the marker at path. A missing file is a first start
// (Recorded false); an unparseable one counts as unclean, since calling a torn
// record clean would hide the crash.
func readBootMarker(path string) service.BootStatus {
	data, err := os.ReadFile(path) //nolint:gosec // G304: path is the server's own data-dir marker
	if err != nil {
		return service.BootStatus{}
	}
	var f bootMarkerFile
	if json.Unmarshal(data, &f) != nil {
		return service.BootStatus{Recorded: true, Unclean: true}
	}
	return service.BootStatus{
		Recorded:    true,
		Unclean:     !f.Clean,
		StartedAt:   f.StartedAt,
		LastPanicAt: f.LastPanicAt,
	}
}

// openBootMarker reads any previous marker and records the new run as in
// progress.
func openBootMarker(path string, startedAt time.Time) (*bootMarker, error) {
	m := &bootMarker{path: path, file: bootMarkerFile{StartedAt: startedAt}}
	if err := m.write(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *bootMarker) write() error {
	data, err := json.Marshal(m.file)
	if err != nil {
		return err
	}
	return writeFileAtomic(m.path, data, 0o600)
}

// recordPanic notes the last recovered panic, so a crash that never reaches
// close still names it at the next start.
func (m *bootMarker) recordPanic(at time.Time) {
	m.mu.Lock()
	m.file.LastPanicAt = at
	err := m.write()
	m.mu.Unlock()
	_ = err // the marker is best-effort: a failure must not panic the recovery path
}

// reported notes that every start stage came up, so the attention panel is
// serving the previous run's exit.
func (m *bootMarker) reported() {
	m.mu.Lock()
	m.unreported = nil
	m.mu.Unlock()
}

// close rewrites the marker as clean, or restores an inherited unclean exit
// this run never reported.
func (m *bootMarker) close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.unreported != nil {
		m.file = *m.unreported
	} else {
		m.file.Clean = true
	}
	return m.write()
}

// writeFileAtomic writes through a sibling temp file and a rename, so a crash
// mid-write cannot leave a torn marker that reads as a clean exit.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm) //nolint:gosec // G304: caller-supplied server-owned path under the data dir
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func bootMarkerPath(dataDir string) string {
	return filepath.Join(dataDir, bootMarkerRelPath)
}

// startBootMarker runs after the database stage, so only the process holding
// the data directory's lock touches the marker.
func (a *App) startBootMarker() error {
	path := bootMarkerPath(a.cfg.Server.DataDir)
	a.prevBoot = readBootMarker(path)
	if a.prevBoot.Recorded && a.prevBoot.Unclean {
		a.log.Warn("the previous run did not shut down cleanly",
			"previous_started_at", formatMarkerTime(a.prevBoot.StartedAt),
			"last_panic_at", formatMarkerTime(a.prevBoot.LastPanicAt))
	}
	marker, err := openBootMarker(path, time.Now())
	if err != nil {
		a.log.Warn("could not write the boot marker; the next start cannot tell how this run ended", "error", err)
		return nil
	}
	if a.prevBoot.Recorded && a.prevBoot.Unclean {
		marker.unreported = &bootMarkerFile{StartedAt: a.prevBoot.StartedAt, LastPanicAt: a.prevBoot.LastPanicAt}
	}
	a.bootMarker = marker
	stackutil.SetPanicRecorder(marker.recordPanic)
	a.onClose("boot-marker", func(context.Context) error {
		stackutil.SetPanicRecorder(nil)
		return marker.close()
	})
	return nil
}

func formatMarkerTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// recordBootStatus folds the previous run's exit into the attention panel.
func (a *App) recordBootStatus(svc *service.Services) {
	if svc == nil || svc.Attention == nil {
		return
	}
	svc.Attention.RecordBootStatus(a.prevBoot)
	svc.Attention.RecordRestoreOutcome(a.restoreOutcome)
}
