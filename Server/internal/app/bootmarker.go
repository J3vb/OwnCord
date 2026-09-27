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

// bootMarkerRelPath is where the boot marker lives under the data directory.
// It is written at start and rewritten at a clean close, so the next start
// can tell whether the previous run ended cleanly (SRE-08).
const bootMarkerRelPath = "boot.json"

// bootMarkerFile is the on-disk record. Clean is false while a run is in
// progress and true only after a clean close rewrites it.
type bootMarkerFile struct {
	StartedAt   time.Time `json:"started_at"`
	LastPanicAt time.Time `json:"last_panic_at,omitzero"`
	Clean       bool      `json:"clean"`
}

// bootMarker is the running process's handle on the marker file: it rewrites
// the file when a panic is recovered and once more on a clean close.
type bootMarker struct {
	path string
	file bootMarkerFile
	// unreported is an unclean previous exit this run has not yet shown on
	// the attention panel; close carries it forward instead of writing clean.
	unreported *bootMarkerFile

	mu sync.Mutex
}

// readBootMarker reads the marker at path. A missing file is a first start
// (Recorded false, so the panel says unknown, not unclean). A file that
// cannot be parsed is treated as recorded and unclean: a torn or corrupt
// record is missing evidence, and calling it clean would hide the crash.
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

// openBootMarker reads any previous marker, records the new run as in
// progress, and returns the handle that will close it. A write failure is
// returned so the caller can decide whether a marker-less run is acceptable;
// production boots anyway and lets the next start report unknown.
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

// recordPanic notes the last recovered panic against the running marker, so a
// crash that never reaches close still names the panic when the next start
// reads it.
func (m *bootMarker) recordPanic(at time.Time) {
	m.mu.Lock()
	m.file.LastPanicAt = at
	err := m.write()
	m.mu.Unlock()
	_ = err // the marker is best-effort: a failure must not panic the recovery path
}

// reported notes that the previous run's exit reached the attention panel.
func (m *bootMarker) reported() {
	m.mu.Lock()
	m.unreported = nil
	m.mu.Unlock()
}

// close rewrites the marker as a clean shutdown, or, when this run inherited
// an unclean exit it never reported, restores that exit so the next start
// still reports it.
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

// writeFileAtomic writes data to path through a sibling temp file and a
// rename, so a crash mid-write cannot leave a torn marker that reads as a
// clean exit. Kept local to app so the marker does not depend on auth's key
// writer.
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

// bootMarkerPath is the marker's path under the data directory.
func bootMarkerPath(dataDir string) string {
	return filepath.Join(dataDir, bootMarkerRelPath)
}

// startBootMarker is the boot-marker stage (SRE-08): it reads the previous
// run's marker, records this run as in progress and installs the
// process-global panic recorder, so a kill, crash or hardware exit leaves
// evidence the next start reports. Its close rewrites the marker as a clean
// shutdown. A marker that cannot be written is logged and not fatal: a server
// that refuses to boot because it cannot leave a note about the NEXT boot is a
// worse outage than a missing note.
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

// formatMarkerTime renders a marker time for a log line, empty when unset.
func formatMarkerTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// recordBootStatus folds the previous run's exit into the attention panel
// (SRE-08). StartRuntime builds the service without knowing the boot marker,
// which only the App's boot-marker stage read.
func (a *App) recordBootStatus(svc *service.Services) {
	if svc == nil || svc.Attention == nil {
		return
	}
	svc.Attention.RecordBootStatus(a.prevBoot)
	if a.bootMarker != nil {
		a.bootMarker.reported()
	}
}
