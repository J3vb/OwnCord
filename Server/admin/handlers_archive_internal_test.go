package admin

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// slowSource yields chunks of size bytes, one every gap, n times.
type slowSource struct {
	size, n int
	gap     time.Duration
}

func (s *slowSource) Read(b []byte) (int, error) {
	if s.n == 0 {
		return 0, io.EOF
	}
	time.Sleep(s.gap)
	s.n--
	return copy(b, make([]byte, min(s.size, len(b)))), nil
}

// serveProgressing streams a slow source through an archiveDeadline over a
// connection whose deadlines start as one fixed window, runs onServe (when
// given) with the server once the request is in, and returns how many bytes
// the client received out of want.
func serveProgressing(t *testing.T, fixedWindow, lifetime time.Duration, onServe func(*http.Server)) (got, want int) {
	t.Helper()
	const chunk, chunks = 1024, 40
	gap := fixedWindow / 8
	want = chunk * chunks
	var srv *httptest.Server
	srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d, _ := startArchive(w, r, fixedWindow, lifetime)
		defer d.release()
		d.touch()
		if onServe != nil {
			onServe(srv.Config)
		}
		w.Header().Set("Content-Length", strconv.Itoa(want))
		_, _ = io.Copy(d, &slowSource{size: chunk, n: chunks, gap: gap})
	}))
	srv.Config.WriteTimeout = fixedWindow
	srv.Start()
	t.Cleanup(srv.Close)

	res, err := srv.Client().Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close() //nolint:errcheck
	body, _ := io.ReadAll(res.Body)
	return len(body), want
}

// A slow but steadily progressing download runs far past a single fixed
// window (40 chunks at window/8 apart is five windows) and still completes.
func TestArchiveDeadline_ProgressingDownloadOutlivesFixedWindow(t *testing.T) {
	got, want := serveProgressing(t, 400*time.Millisecond, time.Minute, nil)
	if got != want {
		t.Fatalf("received %d of %d bytes; a progressing download was cut off", got, want)
	}
}

// However it progresses, the download ends at the lifetime cap.
func TestArchiveDeadline_LifetimeCapsDownload(t *testing.T) {
	got, want := serveProgressing(t, 400*time.Millisecond, 600*time.Millisecond, nil)
	if got >= want {
		t.Fatalf("received all %d bytes; the lifetime cap did not end the download", got)
	}
}

// Server shutdown pulls an in-flight download in to the grace, so it cannot
// hold the drain for its whole lifetime.
func TestArchiveDeadline_ShutdownCapsDownload(t *testing.T) {
	got, want := serveProgressing(t, 400*time.Millisecond, time.Minute, func(srv *http.Server) {
		time.AfterFunc(100*time.Millisecond, shutdownArchives(srv, 200*time.Millisecond))
	})
	if got >= want {
		t.Fatalf("received all %d bytes; shutdown did not cap the download", got)
	}
}

// Shutdown also ends the build: its context is cancelled at the grace, for a
// request already running and for one that starts afterwards.
func TestArchiveDeadline_ShutdownCancelsBuild(t *testing.T) {
	srv := &http.Server{}
	newRequest := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/archive", nil)
		return r.WithContext(context.WithValue(r.Context(), http.ServerContextKey, srv))
	}
	running, runningCtx := startArchive(httptest.NewRecorder(), newRequest(), time.Minute, time.Hour)
	defer running.release()

	shutdownArchives(srv, 10*time.Millisecond)()
	t.Cleanup(func() {
		archivesInFlight.mu.Lock()
		delete(archivesInFlight.closing, srv)
		archivesInFlight.mu.Unlock()
	})
	late, lateCtx := startArchive(httptest.NewRecorder(), newRequest(), time.Minute, time.Hour)
	defer late.release()

	for name, ctx := range map[string]context.Context{"running": runningCtx, "late": lateCtx} {
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
			t.Errorf("%s archive's build context outlived the shutdown grace", name)
		}
	}
}

// An entry removed between the directory listing and its archiving (the live
// server deletes uploads while the walk runs) is left out rather than
// failing the archive; the walk root itself must still exist.
func TestArchiveTree_VanishedEntryIsSkipped(t *testing.T) {
	root := t.TempDir()
	listed := filepath.Join(root, "listed.bin")
	planned := filepath.Join(root, "planned.bin")
	for _, p := range []string{listed, planned} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	var listedEntry fs.DirEntry
	for _, e := range entries {
		if e.Name() == "listed.bin" {
			listedEntry = e
		}
	}
	tree := archiveTree{ctx: t.Context(), db: filepath.Join(root, "chatserver.db")}
	if err := tree.visit(root, "data", planned, entries[1], nil); err != nil {
		t.Fatalf("planning %s: %v", planned, err)
	}
	for _, p := range []string{listed, planned} {
		if err := os.Remove(p); err != nil {
			t.Fatal(err)
		}
	}

	// Gone before its lstat, or before WalkDir could read it: never planned.
	if err := tree.visit(root, "data", listed, listedEntry, nil); err != nil {
		t.Errorf("entry removed before its stat: %v", err)
	}
	if err := tree.visit(root, "data", listed, nil, fs.ErrNotExist); err != nil {
		t.Errorf("walk error for a removed entry: %v", err)
	}
	if err := tree.visit(root, "data", root, nil, fs.ErrNotExist); err == nil {
		t.Error("a missing walk root was skipped; it must fail the archive")
	}
	// On Windows, DirEntry.Info comes from the directory read and cannot see
	// the removal, so listed.bin is planned and dropped by the write below.
	want := 1
	if runtime.GOOS == "windows" {
		want = 2
	}
	if len(tree.entries) != want {
		t.Fatalf("planned %d entries, want %d", len(tree.entries), want)
	}

	// Planned, then gone before its open: skipped while writing.
	tree.snapshotAdded = true
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if err := tree.write(zw); err != nil {
		t.Errorf("entry removed before its open: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 0 {
		t.Errorf("archive carries entries for removed files: %v", zr.File)
	}
}
