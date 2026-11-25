package admin_test

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// The scheduled full archive shares the package-wide archiveBusy flag with the manual download, so none of
// these tests runs in parallel with each other or with the existing archive tests.

// schedFixture is the archive fixture plus the pieces MaintainBackups needs.
type schedFixture struct {
	archiveFixture
	settings *service.SettingsService
	backups  string
	dbFile   string
	opts     admin.SetupOptions
}

func newSchedFixture(t *testing.T, scope, retention string, configure ...func(*config.Config)) schedFixture {
	t.Helper()
	admin.ResetScheduledArchive()
	t.Cleanup(admin.ResetScheduledArchive)
	var cfg *config.Config
	f := newArchiveFixture(t, func(_ string, c *config.Config) {
		for _, fn := range configure {
			fn(c)
		}
		cfg = c
	})
	// The fixture's own old.db is fresh, which would count as the newest database copy.
	if err := os.Remove(filepath.Join(cfg.Backup.Dir, "old.db")); err != nil {
		t.Fatal(err)
	}
	settings := service.NewSettingsService(f.database)
	updates := map[string]string{"backup_schedule": "daily", "backup_retention": retention}
	if scope != "" {
		updates["backup_scope"] = scope
	}
	if _, err := settings.Patch(context.Background(), 1, updates); err != nil {
		t.Fatalf("Patch settings: %v", err)
	}
	return schedFixture{
		archiveFixture: f,
		settings:       settings,
		backups:        cfg.Backup.Dir,
		dbFile:         filepath.Join(f.dataDir, "chatserver.db"),
		opts:           admin.SetupOptions{ConfigPath: f.config, RunningCfg: cfg},
	}
}

// tick runs one maintenance pass, with the archive job wired in, and waits for the job it started.
func (s schedFixture) tick(t *testing.T) error {
	t.Helper()
	err := admin.MaintainBackups(context.Background(), s.database, s.settings, s.backups, s.dbFile, admin.WithScheduledArchive(s.opts))
	if werr := admin.WaitScheduledArchives(context.Background()); werr != nil {
		t.Fatalf("WaitScheduledArchives: %v", werr)
	}
	return err
}

func (s schedFixture) names(t *testing.T, suffix string) []string {
	t.Helper()
	entries, err := os.ReadDir(s.backups)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), suffix) && strings.HasPrefix(e.Name(), "scheduled_") {
			out = append(out, e.Name())
		}
	}
	return out
}

func (s schedFixture) workDirs(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(s.backups)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "owncord-archive-") {
			out = append(out, e.Name())
		}
	}
	return out
}

// age moves every scheduled file's mtime back, so the next pass sees both kinds as stale.
func (s schedFixture) age(t *testing.T, by time.Duration) {
	t.Helper()
	for _, suffix := range []string{".db", ".zip"} {
		for _, n := range s.names(t, suffix) {
			backdate(t, filepath.Join(s.backups, n), by)
		}
	}
}

func TestScheduledArchive_EverythingKeepsDatabaseAndArchive(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	if err := s.tick(t); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	dbs, zips := s.names(t, ".db"), s.names(t, ".zip")
	if len(dbs) != 1 || len(zips) != 1 {
		t.Fatalf("scheduled files = %v and %v, want one .db and one .zip", dbs, zips)
	}
	if left := s.workDirs(t); len(left) != 0 {
		t.Errorf("work dirs left behind: %v", left)
	}
	zr, err := zip.OpenReader(filepath.Join(s.backups, zips[0]))
	if err != nil {
		t.Fatalf("stored archive does not open: %v", err)
	}
	defer zr.Close() //nolint:errcheck
	names := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	for _, want := range []string{"data/chatserver.db", "data/totp.key", "data/uploads/hello.bin", "config.yaml"} {
		if !slices.Contains(names, want) {
			t.Errorf("archive has no %s; entries: %v", want, names)
		}
	}
	// The backup folder is inside the data folder here and must not be zipped into itself.
	for _, n := range names {
		if strings.Contains(n, "scheduled_") || strings.Contains(n, "owncord-archive-") {
			t.Errorf("archive contains its own backup folder entry %s", n)
		}
	}

	// A second pass inside the interval makes nothing new.
	if err := s.tick(t); err != nil {
		t.Fatalf("MaintainBackups #2: %v", err)
	}
	if got := s.names(t, ".zip"); len(got) != 1 {
		t.Errorf("archives after an in-interval pass = %v, want still one", got)
	}
}

func TestScheduledArchive_FileModeIsOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not enforced on Windows")
	}
	s := newSchedFixture(t, "everything", "30")
	if err := s.tick(t); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	zips := s.names(t, ".zip")
	if len(zips) != 1 {
		t.Fatalf("archives = %v", zips)
	}
	info, err := os.Stat(filepath.Join(s.backups, zips[0]))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("stored archive mode = %o, want 600", perm)
	}
}

func TestScheduledArchive_DatabaseScopeAndUnsetMakeNoArchive(t *testing.T) {
	for _, scope := range []string{"database", ""} {
		name := scope
		if name == "" {
			name = "unset"
		}
		t.Run(name, func(t *testing.T) {
			s := newSchedFixture(t, scope, "30")
			if scope == "" {
				// A server with people on it keeps the migration's "unset".
				if err := s.database.ApplySettings(context.Background(), map[string]string{"backup_scope": "unset"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.tick(t); err != nil {
				t.Fatalf("MaintainBackups: %v", err)
			}
			if got := s.names(t, ".db"); len(got) != 1 {
				t.Errorf("database copies = %v, want one", got)
			}
			if got := s.names(t, ".zip"); len(got) != 0 {
				t.Errorf("scope %s made an archive: %v", name, got)
			}
		})
	}
}

func TestScheduledArchive_ScheduleOffMakesNothing(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	if _, err := s.settings.Patch(context.Background(), 1, map[string]string{"backup_schedule": "off"}); err != nil {
		t.Fatal(err)
	}
	if err := s.tick(t); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	if len(s.names(t, ".db"))+len(s.names(t, ".zip")) != 0 {
		t.Error("a pass with the schedule off made a backup")
	}
}

// failingWriter is a disk that fills: it takes max bytes, then every write fails with ENOSPC.
type failingWriter struct {
	w    io.Writer
	left int
}

func (f *failingWriter) Write(p []byte) (int, error) {
	if f.left <= 0 {
		return 0, &os.PathError{Op: "write", Path: "archive.zip", Err: syscall.ENOSPC}
	}
	if len(p) > f.left {
		n, _ := f.w.Write(p[:f.left])
		f.left = 0
		return n, &os.PathError{Op: "write", Path: "archive.zip", Err: syscall.ENOSPC}
	}
	f.left -= len(p)
	return f.w.Write(p)
}

// Edge case: the disk fills while the archive is written. No .zip appears, the work dir is gone, the archive
// from the last good run is kept, the failure is recorded for the attention panel, and the tick is not failed.
func TestScheduledArchive_DiskFillsWhileWriting(t *testing.T) {
	for _, tc := range []struct {
		name      string
		configure func(*config.Config)
		wrap      func(io.Writer) io.Writer
		wantText  string
	}{
		{
			name:     "write fails part way",
			wrap:     func(w io.Writer) io.Writer { return &failingWriter{w: w, left: 200} },
			wantText: "no space left on device",
		},
		{
			name:      "free space floor refuses the build",
			configure: func(c *config.Config) { c.Server.MinFreeDiskMB = 1 << 40 },
			wantText:  "min_free_disk_mb",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newSchedFixture(t, "everything", "30")
			// One good archive first, with the floor still at its default.
			if err := s.tick(t); err != nil {
				t.Fatalf("first pass: %v", err)
			}
			previous := s.names(t, ".zip")
			if len(previous) != 1 {
				t.Fatalf("first pass archives = %v", previous)
			}
			previousInfo, err := os.Stat(filepath.Join(s.backups, previous[0]))
			if err != nil {
				t.Fatal(err)
			}

			if tc.configure != nil {
				tc.configure(s.opts.RunningCfg)
			}
			if tc.wrap != nil {
				defer admin.SetArchiveOutWrapper(tc.wrap)()
			}
			s.age(t, 48*time.Hour)
			previousInfo2, err := os.Stat(filepath.Join(s.backups, previous[0]))
			if err != nil {
				t.Fatal(err)
			}

			if err := s.tick(t); err != nil {
				t.Errorf("a failed archive failed the tick: %v (it must be recorded, not returned)", err)
			}
			if got := s.names(t, ".zip"); len(got) != 1 || got[0] != previous[0] {
				t.Errorf("archives after the failure = %v, want only the previous %v", got, previous)
			}
			if left := s.workDirs(t); len(left) != 0 {
				t.Errorf("work dirs left behind: %v", left)
			}
			after, err := os.Stat(filepath.Join(s.backups, previous[0]))
			if err != nil || after.Size() != previousInfo.Size() || !after.ModTime().Equal(previousInfo2.ModTime()) {
				t.Errorf("the previous archive changed: %v %v", after, err)
			}
			// No stray .zip or .tmp of any kind in the backup folder.
			entries, _ := os.ReadDir(s.backups)
			for _, e := range entries {
				if e.Name() != previous[0] && (strings.HasSuffix(e.Name(), ".zip") || strings.HasSuffix(e.Name(), ".tmp")) {
					t.Errorf("stray file %s in the backup folder", e.Name())
				}
			}

			// The failure is on record for attention, and the archive's age is the previous one's.
			st, err := admin.ScheduledArchiveStatus(s.backups)
			if err != nil {
				t.Fatal(err)
			}
			if st.FailingSince.IsZero() || st.FailedAt.IsZero() || !strings.Contains(st.Reason, tc.wantText) {
				t.Errorf("status = %+v, want a recorded failure naming %q", st, tc.wantText)
			}
			if time.Since(st.Newest) < 47*time.Hour {
				t.Errorf("Newest = %v, want the previous (aged) archive", st.Newest)
			}
			if strings.Contains(st.Reason, s.backups) {
				t.Errorf("reason leaks the backup folder path: %q", st.Reason)
			}

			// It backs off: the next pass does not try again for an hour, so the failure is not re-recorded.
			failedAt := st.FailedAt
			if err := s.tick(t); err != nil {
				t.Fatalf("pass during back-off: %v", err)
			}
			st2, _ := admin.ScheduledArchiveStatus(s.backups)
			if !st2.FailedAt.Equal(failedAt) {
				t.Error("a pass during the back-off ran the archive again")
			}
		})
	}
}

// A recovered run clears the failure.
func TestScheduledArchive_SuccessClearsFailure(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	restore := admin.SetArchiveOutWrapper(func(w io.Writer) io.Writer { return &failingWriter{w: w} })
	if err := s.tick(t); err != nil {
		t.Fatal(err)
	}
	restore()
	if st, _ := admin.ScheduledArchiveStatus(s.backups); st.FailingSince.IsZero() {
		t.Fatal("no failure recorded")
	}
	admin.ResetScheduledArchiveBackoff()
	if err := s.tick(t); err != nil {
		t.Fatal(err)
	}
	st, _ := admin.ScheduledArchiveStatus(s.backups)
	if !st.FailingSince.IsZero() || st.Reason != "" || st.Newest.IsZero() {
		t.Errorf("status after recovery = %+v, want no failure and a stored archive", st)
	}
}

// Edge case: two archive runs overlap. A manual download holds archiveBusy while the scheduled job fires: the
// job is skipped with no error and no file, and never builds alongside it.
func TestScheduledArchive_SkippedWhileManualDownloadBuilds(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	var builds atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	defer admin.SetArchiveBeforeSnapshotHook(func() {
		if builds.Add(1) == 1 {
			close(entered)
			<-release
		}
	})()

	_, path := issueArchiveLink(t, s.archiveFixture, s.token)
	done := make(chan int)
	go func() { done <- getRawLink(t, s.archiveFixture, path).Code }()
	<-entered

	if err := s.tick(t); err != nil {
		t.Errorf("a skipped scheduled archive returned an error: %v", err)
	}
	if got := s.names(t, ".zip"); len(got) != 0 {
		t.Errorf("a scheduled archive was made while the manual one held the flag: %v", got)
	}
	if !admin.ArchiveBusyForTest() {
		t.Error("the manual build's flag was released by the skipped job")
	}
	if st, _ := admin.ScheduledArchiveStatus(s.backups); !st.FailedAt.IsZero() {
		t.Errorf("a skip was recorded as a failure: %+v", st)
	}
	// The database copy is separate and is still taken.
	if got := s.names(t, ".db"); len(got) != 1 {
		t.Errorf("database copies = %v, want the .db taken regardless", got)
	}

	close(release)
	if code := <-done; code != http.StatusOK {
		t.Fatalf("manual download = %d, want 200", code)
	}
	if n := builds.Load(); n != 1 {
		t.Errorf("builds = %d, want only the manual one", n)
	}
	// The next pass, with the flag free, does the archive.
	if err := s.tick(t); err != nil {
		t.Fatal(err)
	}
	if got := s.names(t, ".zip"); len(got) != 1 {
		t.Errorf("archives after the next pass = %v, want one", got)
	}
}

// The reverse: the scheduled job holds archiveBusy and a manual download, a new link and a second scheduled
// pass all stay out.
func TestScheduledArchive_ManualDownloadRefusedWhileJobBuilds(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	var builds atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	defer admin.SetArchiveBeforeSnapshotHook(func() {
		builds.Add(1)
		select {
		case <-entered:
		default:
			close(entered)
		}
		<-release
	})()

	// The tick starts the job and returns without waiting for it.
	started := make(chan error, 1)
	go func() {
		started <- admin.MaintainBackups(context.Background(), s.database, s.settings, s.backups, s.dbFile, admin.WithScheduledArchive(s.opts))
	}()
	select {
	case err := <-started:
		if err != nil {
			t.Fatalf("MaintainBackups: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the tick waited for the archive build")
	}
	<-entered

	if w := doRequest(t, s.handler, http.MethodGet, "/archive", s.token, nil); w.Code != http.StatusConflict {
		t.Errorf("GET /archive during the scheduled build = %d, want 409", w.Code)
	}
	if w := doRequest(t, s.handler, http.MethodPost, "/archive/link", s.token, map[string]any{}); w.Code != http.StatusConflict {
		t.Errorf("POST /archive/link during the scheduled build = %d, want 409", w.Code)
	}
	// Another scheduled pass finds the flag taken and skips.
	if err := admin.MaintainBackups(context.Background(), s.database, s.settings, s.backups, s.dbFile, admin.WithScheduledArchive(s.opts)); err != nil {
		t.Errorf("second pass: %v", err)
	}

	close(release)
	if err := admin.WaitScheduledArchives(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := builds.Load(); n != 1 {
		t.Errorf("builds = %d, want exactly one", n)
	}
	if got := s.names(t, ".zip"); len(got) != 1 {
		t.Errorf("archives = %v, want exactly one", got)
	}
	if admin.ArchiveBusyForTest() {
		t.Error("archiveBusy is still held after the job ended")
	}
}

// A shutdown cancels the job, which is not a failure to report.
func TestScheduledArchive_ShutdownIsNotAFailure(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	ctx, cancel := context.WithCancel(context.Background())
	entered := make(chan struct{})
	defer admin.SetArchiveBeforeSnapshotHook(func() {
		close(entered)
		cancel()
	})()
	if err := admin.MaintainBackups(ctx, s.database, s.settings, s.backups, s.dbFile, admin.WithScheduledArchive(s.opts)); err != nil {
		t.Fatal(err)
	}
	<-entered
	waitCtx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	if err := admin.WaitScheduledArchives(waitCtx); err != nil {
		t.Fatalf("the job did not stop after its context was cancelled: %v", err)
	}
	if got := s.names(t, ".zip"); len(got) != 0 {
		t.Errorf("archives after a cancelled run = %v", got)
	}
	if left := s.workDirs(t); len(left) != 0 {
		t.Errorf("work dirs left behind: %v", left)
	}
	if st, _ := admin.ScheduledArchiveStatus(s.backups); !st.FailedAt.IsZero() {
		t.Errorf("a shutdown was recorded as a failure: %+v", st)
	}
}

func writeStoredArchives(t *testing.T, dir string, ages ...time.Duration) []string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(ages))
	for i, age := range ages {
		name := "scheduled_20260101_0000" + string(rune('0'+i/10)) + string(rune('0'+i%10)) + ".zip"
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("PK stand-in"), 0o600); err != nil {
			t.Fatal(err)
		}
		backdate(t, path, age)
		names = append(names, name)
	}
	return names
}

const day = 24 * time.Hour

func TestScheduledArchive_RetentionCapsCountAndDays(t *testing.T) {
	for _, tc := range []struct {
		name      string
		retention string
		ages      []time.Duration // index = file number; newest first is NOT assumed
		keep      []int
	}{
		{"retention 0 still caps at three", "0", []time.Duration{day, 2 * day, 3 * day, 4 * day, 5 * day}, []int{0, 1, 2}},
		{"under the cap, nothing goes", "0", []time.Duration{day, 2 * day}, []int{0, 1}},
		{"days apply under the cap", "7", []time.Duration{day, 2 * day, 10 * day, 20 * day, 30 * day}, []int{0, 1}},
		{"the newest is kept however old", "7", []time.Duration{10 * day, 20 * day, 30 * day}, []int{0}},
		{"count cap beats a long window", "365", []time.Duration{day, 2 * day, 3 * day, 4 * day}, []int{0, 1, 2}},
		{"order on disk does not matter", "0", []time.Duration{5 * day, day, 4 * day, 2 * day, 3 * day}, []int{1, 3, 4}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Scope database so the pass builds nothing: only the prune is under test.
			s := newSchedFixture(t, "database", tc.retention)
			names := writeStoredArchives(t, s.backups, tc.ages...)
			if err := s.tick(t); err != nil {
				t.Fatal(err)
			}
			want := make([]string, 0, len(tc.keep))
			for _, i := range tc.keep {
				want = append(want, names[i])
			}
			got := s.names(t, ".zip")
			if len(got) != len(want) {
				t.Fatalf("archives kept = %v, want %v", got, want)
			}
			for _, w := range want {
				if !slices.Contains(got, w) {
					t.Errorf("archives kept = %v, want %s among them", got, w)
				}
			}
		})
	}
}

// The prune leaves database copies and safety copies alone, and a .db never counts toward the zip cap.
func TestScheduledArchive_RetentionLeavesOtherKindsAlone(t *testing.T) {
	s := newSchedFixture(t, "database", "0")
	writeStoredArchives(t, s.backups, day, 2*day, 3*day, 4*day)
	other := []string{"scheduled_20250101_000000.db", "chatserver_20250101_000000.db", "pre_restore_20250101_000000.db", "notes.zip"}
	for _, n := range other {
		if err := os.WriteFile(filepath.Join(s.backups, n), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		backdate(t, filepath.Join(s.backups, n), 400*day)
	}
	if err := s.tick(t); err != nil {
		t.Fatal(err)
	}
	for _, n := range other {
		if _, err := os.Stat(filepath.Join(s.backups, n)); err != nil && n != "scheduled_20250101_000000.db" {
			t.Errorf("%s was removed: %v", n, err)
		}
	}
	if got := s.names(t, ".zip"); len(got) != 3 {
		t.Errorf("scheduled archives = %v, want 3", got)
	}
}

func TestBackupList_ShowsKind(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	if err := s.tick(t); err != nil {
		t.Fatal(err)
	}
	w := doRequest(t, s.handler, http.MethodGet, "/backups", s.token, nil)
	requireStatus(t, w, http.StatusOK)
	list := decodeBody[[]struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}](t, w)
	kinds := map[string]string{}
	for _, e := range list {
		kinds[filepath.Ext(e.Name)] = e.Kind
	}
	if kinds[".db"] != "database" || kinds[".zip"] != "full" {
		t.Errorf("kinds by extension = %v, want .db database and .zip full (list: %+v)", kinds, list)
	}
}

func TestRestore_RefusesAFullArchive(t *testing.T) {
	s := newSchedFixture(t, "database", "0")
	names := writeStoredArchives(t, s.backups, day)
	w := doRequest(t, s.handler, http.MethodPost, "/backups/"+names[0]+"/restore", s.token, map[string]any{})
	requireStatus(t, w, http.StatusBadRequest)
	if !strings.Contains(w.Body.String(), "full archive") || !strings.Contains(w.Body.String(), "docs/hosting/backups.md") ||
		!strings.Contains(w.Body.String(), "remove the data folder") || !strings.Contains(w.Body.String(), "config.yaml") {
		t.Errorf("restore refusal does not point at the manual steps: %s", w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.backups, names[0])); err != nil {
		t.Errorf("the refused archive is gone: %v", err)
	}
	if entries, _ := os.ReadDir(s.dataDir); containsRestoreMarker(entries) {
		t.Error("a refused restore staged something")
	}
}

func containsRestoreMarker(entries []os.DirEntry) bool {
	for _, e := range entries {
		if strings.Contains(e.Name(), "restore") {
			return true
		}
	}
	return false
}

// A stored archive downloads through the archive link, which is the restorer's, not the backup link.
func TestStoredArchive_DownloadsThroughTheArchiveLink(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	if err := s.tick(t); err != nil {
		t.Fatal(err)
	}
	name := s.names(t, ".zip")[0]
	want, err := os.ReadFile(filepath.Join(s.backups, name))
	if err != nil {
		t.Fatal(err)
	}

	w := doRequest(t, s.handler, http.MethodPost, "/archive/link", s.token, map[string]any{"name": name})
	requireStatus(t, w, http.StatusOK)
	resp := decodeBody[struct {
		Path string `json:"path"`
	}](t, w)
	dl := getRawLink(t, s.archiveFixture, resp.Path)
	requireStatus(t, dl, http.StatusOK)
	if ct := dl.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type = %q", ct)
	}
	if !strings.Contains(dl.Header().Get("Content-Disposition"), name) {
		t.Errorf("Content-Disposition = %q, want the file's name", dl.Header().Get("Content-Disposition"))
	}
	if got := dl.Body.Bytes(); !bytes.Equal(got, want) {
		t.Errorf("downloaded %d bytes, stored file is %d: the link built a new archive instead of serving the stored one", len(got), len(want))
	}
	if again := getRawLink(t, s.archiveFixture, resp.Path); again.Code == http.StatusOK {
		t.Error("a stored archive link worked twice")
	}

	// Other names are not downloadable through it.
	for _, bad := range []string{"../" + name, name + ".bak", "chatserver_x.db", "owncord-archive.zip", "nope_20260101_000000.zip", "scheduled_missing.zip"} {
		if w := doRequest(t, s.handler, http.MethodPost, "/archive/link", s.token, map[string]any{"name": bad}); w.Code != http.StatusNotFound {
			t.Errorf("link for %q = %d, want 404", bad, w.Code)
		}
	}
	// The one-file backup link stays database-only.
	if w := doRequest(t, s.handler, http.MethodPost, "/backups/"+name+"/link", s.token, map[string]any{}); w.Code != http.StatusNotFound {
		t.Errorf("backup link for a zip = %d, want 404", w.Code)
	}
}

// Holding only MANAGE_BACKUPS gives no way to a stored archive, and a link goes dead when the holder loses
// RESTORE_BACKUPS before it is opened.
func TestStoredArchive_NeedsRestoreBackups(t *testing.T) {
	s := newSchedFixture(t, "everything", "30")
	if err := s.tick(t); err != nil {
		t.Fatal(err)
	}
	name := s.names(t, ".zip")[0]

	_, keeper := createRoleUser(t, s.database, 31, "Keeper", permissions.ManageBackups, 40, "backupkeeper")
	if w := doRequest(t, s.handler, http.MethodPost, "/archive/link", keeper, map[string]any{"name": name}); w.Code != http.StatusForbidden {
		t.Errorf("MANAGE_BACKUPS holder POST /archive/link = %d, want 403", w.Code)
	}

	uid, restorer := createRoleUser(t, s.database, 32, "Restorer", permissions.RestoreBackups, 41, "backuprestorer")
	w := doRequest(t, s.handler, http.MethodPost, "/archive/link", restorer, map[string]any{"name": name})
	requireStatus(t, w, http.StatusOK)
	resp := decodeBody[struct {
		Path string `json:"path"`
	}](t, w)
	if _, err := s.database.ExecContext(context.Background(), `UPDATE roles SET permissions = 0 WHERE id = 32`); err != nil {
		t.Fatal(err)
	}
	_ = uid
	if dl := getRawLink(t, s.archiveFixture, resp.Path); dl.Code != http.StatusForbidden {
		t.Errorf("link after losing RESTORE_BACKUPS = %d, want 403", dl.Code)
	}
}

func TestScheduledArchive_BuildNeverHoldsMoreThanTheCap(t *testing.T) {
	s := newSchedFixture(t, "everything", "0")
	old := writeStoredArchives(t, s.backups, 2*day, 3*day, 4*day)
	during := -1
	restore := admin.SetArchiveOutWrapper(func(w io.Writer) io.Writer {
		during = len(s.names(t, ".zip"))
		return w
	})
	defer restore()
	if err := s.tick(t); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	if during != 2 {
		t.Errorf("stored archives while the build ran = %d, want 2 (one fewer than the cap)", during)
	}
	got := s.names(t, ".zip")
	if len(got) != 3 {
		t.Fatalf("archives after the build = %v, want three", got)
	}
	for _, n := range old[2:] {
		if slices.Contains(got, n) {
			t.Errorf("oldest archive %s kept; it should have made room for the build", n)
		}
	}
}
