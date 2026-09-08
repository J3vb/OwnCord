package api_test

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/storage"
)

// B5-2 follow-up: the upload handler now admits an upload's bytes against
// the quota and the headroom floor before it reads a single byte of the
// body, and never spools any part of it outside the storage directory. The
// tests in this file prove those two properties at the HTTP seam; the
// service-level Resize/Recount proofs live in service/upload_quota_test.go.

// redirectProcessTempDir points the process's temporary directory at a fresh,
// empty directory for the duration of the test and returns it. TMPDIR is
// what Unix's os.TempDir() reads; TMP and TEMP are what Windows reads. If the
// platform does not honor the redirection (a sandboxed test runner, say) the
// test skips rather than silently checking the wrong directory.
func redirectProcessTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	t.Setenv("TMP", dir)
	t.Setenv("TEMP", dir)
	got, err1 := filepath.EvalSymlinks(os.TempDir())
	want, err2 := filepath.EvalSymlinks(dir)
	if err1 != nil || err2 != nil || got != want {
		t.Skipf("os.TempDir() = %q, want %q; platform did not honor TMPDIR/TMP/TEMP", os.TempDir(), dir)
	}
	return dir
}

// TestUpload_LargeBodyNeverStagesOutsideTheStorageDir: a body comfortably
// above the 10 MiB in-memory multipart threshold and below the 100 MiB
// request cap must never touch the process temp directory — it goes
// straight to the storage directory. Against the unfixed handler,
// ParseMultipartForm spills the excess to os.TempDir() and this fails with a
// leftover multipart-* file.
func TestUpload_LargeBodyNeverStagesOutsideTheStorageDir(t *testing.T) {
	tmpDir := redirectProcessTempDir(t)

	real, err := storage.New(t.TempDir(), 50) // 50 MiB max file size, independent of the redirected temp dir
	if err != nil {
		t.Fatal(err)
	}
	h := newQuotaHarness(t, real)
	h.limits(t, 0, 0, nil) // no quota, no floor: only the staging location is under test

	const size = 20 << 20 // above the 10 MiB in-memory multipart threshold, below the 100 MiB request cap
	body := bytes.Repeat([]byte("z"), size)
	rr := doUpload(t, h.router, h.token, "file", "big.bin", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("large upload: %d %s", rr.Code, rr.Body.String())
	}

	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Fatalf("temp dir has %d entries after a large upload, want 0: %v", len(entries), names)
	}
}

// countingReader counts the bytes Read has returned across the life of the
// reader, safe for concurrent inspection while a handler is still running.
type countingReader struct {
	r io.Reader
	n atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// TestUpload_UnknownLengthIsFloorGatedBeforeTheBodyIsRead: a chunked request
// carries no Content-Length (-1). The floor must still refuse it, and it
// must refuse it before a single byte of the body is read. Against the
// unfixed handler the floor check only runs when Content-Length > 0, so an
// unknown length skips it entirely and the whole body gets read (and, above
// the in-memory threshold, spooled) before Reserve ever sees it.
func TestUpload_UnknownLengthIsFloorGatedBeforeTheBodyIsRead(t *testing.T) {
	h := newQuotaHarness(t, nil)
	var probes atomic.Int32
	h.limits(t, 0, 256<<20, func(string) (uint64, error) { probes.Add(1); return 100 << 20, nil })

	body, contentType := makeMultipartFile(t, "file", "f.bin", bytes.Repeat([]byte("x"), 1<<20))
	cr := &countingReader{r: body}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", cr)
	req.ContentLength = -1
	req.TransferEncoding = []string{"chunked"}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+h.token)
	rr := httptest.NewRecorder()
	h.router.ServeHTTP(rr, req)

	assertErrorCode(t, rr, http.StatusInsufficientStorage, "STORAGE_LOW_DISK")
	if probes.Load() < 1 {
		t.Fatal("the floor probe never ran for an unknown-length body")
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a floor refusal on an unknown length wrote a file")
	}
	// The point: the body was never read to find out its true size.
	if got := cr.n.Load(); got > 1024 {
		t.Fatalf("body was read %d bytes before the floor refused it, want it left essentially untouched", got)
	}
}

// chunkedUpload builds and serves a request with no declared Content-Length —
// httptest's stand-in for a real chunked client, since httptest.NewRequest
// cannot itself produce chunked transfer-encoding on the wire.
func chunkedUpload(t *testing.T, h *quotaHarness, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := makeMultipartFile(t, "file", "f.bin", content)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", body)
	req.ContentLength = -1
	req.TransferEncoding = []string{"chunked"}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+h.token)
	rr := httptest.NewRecorder()
	h.router.ServeHTTP(rr, req)
	return rr
}

// TestUpload_UnknownLengthAdmittedUnderAPerFileCap: an unknown-length body
// must reserve at most upload.max_size_mb, not the full request cap — a
// user whose quota sits strictly between the two can still upload. Against
// the unfixed handler the envelope is always the 100 MiB request cap, so
// this quota (10 MiB) refuses every chunked upload outright.
func TestUpload_UnknownLengthAdmittedUnderAPerFileCap(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limitsCapped(t, 10<<20, 0, nil, 5<<20) // quota above the 5 MiB cap, below the 100 MiB request cap

	rr := chunkedUpload(t, h, []byte("hello"))
	if rr.Code != http.StatusCreated {
		t.Fatalf("chunked upload under a per-file cap smaller than the quota: %d %s", rr.Code, rr.Body.String())
	}
}

// TestUpload_UnknownLengthRefusedWhenQuotaBelowTheCap: the same shape, but
// the quota sits below the cap, so it still refuses — admitting the cap
// instead of the request size is a tighter bound, not an open one.
func TestUpload_UnknownLengthRefusedWhenQuotaBelowTheCap(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limitsCapped(t, 3<<20, 0, nil, 5<<20) // quota below the 5 MiB cap

	rr := chunkedUpload(t, h, []byte("hello"))
	assertErrorCode(t, rr, http.StatusInsufficientStorage, "STORAGE_QUOTA_EXCEEDED")
}

// TestUpload_UnknownLengthReservesThePerFileCapBeforeTheBodyIsRead is
// TestUpload_UnknownLengthIsFloorGatedBeforeTheBodyIsRead's mirror image: a
// floor with just enough headroom for the 5 MiB cap, but not for the 100 MiB
// request cap, still admits — proving the reservation made before any byte
// is read is the cap, not uploadMaxBodySize.
func TestUpload_UnknownLengthReservesThePerFileCapBeforeTheBodyIsRead(t *testing.T) {
	h := newQuotaHarness(t, nil)
	var probes atomic.Int32
	// 60 MiB free, 50 MiB floor: room for 10 MiB in flight — enough for the
	// 5 MiB cap, nowhere near enough for a 100 MiB worst case.
	h.limitsCapped(t, 0, 50<<20, func(string) (uint64, error) { probes.Add(1); return 60 << 20, nil }, 5<<20)

	rr := chunkedUpload(t, h, []byte("hello"))
	if rr.Code != http.StatusCreated {
		t.Fatalf("chunked upload reserving the 5 MiB cap under a floor that only has room for the cap: %d %s", rr.Code, rr.Body.String())
	}
	if probes.Load() < 1 {
		t.Fatal("the floor probe never ran for an unknown-length body")
	}
}

// TestUpload_PlainFieldNamedFileIsNotAFile: a plain form value named "file"
// (no filename= attribute — not a file part at all) must still be refused
// as a missing file field, matching what r.FormFile("file") always gave a
// same-named non-file value. findFilePart matches on form name alone, so
// this would otherwise upload the field's own bytes as a nameless file.
func TestUpload_PlainFieldNamedFileIsNotAFile(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limits(t, 0, 0, nil)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("file", "hello"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+h.token)
	rr := httptest.NewRecorder()
	h.router.ServeHTTP(rr, req)

	assertErrorCode(t, rr, http.StatusBadRequest, "BAD_REQUEST")
	if !strings.Contains(rr.Body.String(), "missing file field") {
		t.Fatalf("body = %s, want the missing-file-field message", rr.Body.String())
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a plain field named \"file\" was uploaded as a file")
	}
}

// blockThenCancelReader returns bytes from the wrapped reader until budget
// bytes have been handed out, signals ready exactly once, then blocks until
// ctx is done and returns its error — modeling a client that sends some
// bytes, stalls, and is then cut off. The ready signal lets the caller wait
// until the stall has actually begun (bytes already read past auth and into
// the body) before cancelling, rather than racing the handler's own setup.
type blockThenCancelReader struct {
	r         io.Reader
	budget    int64
	readyOnce sync.Once
	ready     chan struct{}
	done      <-chan struct{}
	err       func() error
}

func (b *blockThenCancelReader) Read(p []byte) (int, error) {
	if b.budget <= 0 {
		b.readyOnce.Do(func() { close(b.ready) })
		<-b.done
		return 0, b.err()
	}
	if int64(len(p)) > b.budget {
		p = p[:b.budget]
	}
	n, err := b.r.Read(p)
	b.budget -= int64(n)
	return n, err
}

// TestUpload_CancelledMidBodyReleasesTheChargeAndLeavesNoFile: a body that
// stalls partway through and is then cut off (its context canceled) must
// leave the uploader's counter exactly where it started and no file behind,
// in the storage directory or in the redirected temp directory.
func TestUpload_CancelledMidBodyReleasesTheChargeAndLeavesNoFile(t *testing.T) {
	tmpDir := redirectProcessTempDir(t)

	real, err := storage.New(t.TempDir(), 50)
	if err != nil {
		t.Fatal(err)
	}
	h := newQuotaHarness(t, real)
	h.limits(t, 0, 0, nil)
	before := h.used(t)

	const size = 20 << 20 // above the in-memory threshold, so bytes are landing on disk before the stall
	body, contentType := makeMultipartFile(t, "file", "f.bin", bytes.Repeat([]byte("q"), size))
	ctx, cancel := context.WithCancel(context.Background())
	reader := &blockThenCancelReader{r: body, budget: 2 << 20, ready: make(chan struct{}), done: ctx.Done(), err: ctx.Err}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", reader)
	req.ContentLength = int64(body.Len())
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+h.token)
	req = req.WithContext(ctx)
	rr := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		h.router.ServeHTTP(rr, req)
		close(done)
	}()
	<-reader.ready // 2 MiB has been read; the client now stalls
	cancel()
	<-done

	if rr.Code == http.StatusCreated {
		t.Fatalf("a cancelled upload was still created: %s", rr.Body.String())
	}
	if got := h.used(t); got != before {
		t.Fatalf("counter = %d after a cancelled upload, want %d (unchanged)", got, before)
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a cancelled upload left a file in the storage dir")
	}
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("a cancelled upload left %d entries in the temp dir", len(entries))
	}
}

// trackedStore wraps a FileStore and reports the cumulative bytes
// successfully written through it, independent of which directory the
// wrapped store actually keeps — the "as bytes land" signal a shrinking
// free-space probe reads in TestUpload_ConcurrentLargeBodiesNeverCrossTheFloor.
type trackedStore struct {
	api.FileStore
	onDisk *atomic.Uint64
}

func (t trackedStore) Save(name string, r io.Reader) (int64, error) {
	n, err := t.FileStore.Save(name, r)
	if err == nil {
		t.onDisk.Add(uint64(n))
	}
	return n, err
}

// dirByteSize sums the current size of every regular file directly in dir,
// tolerating a file disappearing mid-scan (a concurrent racer's cleanup).
func dirByteSize(dir string) uint64 {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var total uint64
	for _, e := range entries {
		if info, err := e.Info(); err == nil {
			total += uint64(info.Size())
		}
	}
	return total
}

// TestUpload_ConcurrentLargeBodiesNeverCrossTheFloor: eight racers each
// upload a body above the in-memory multipart threshold against a
// free-space probe that reflects real bytes as they land in the storage dir
// AND real bytes staged in the process temp dir — the same single volume a
// real deployment usually has underneath both. Only the racers whose bytes
// fit under the floor may be admitted, and the floor must never be crossed
// at any observed probe reading. Against the unfixed handler, a body above
// the in-memory threshold spools to the temp dir during ParseMultipartForm
// and is never removed on the success path (httptest never runs the
// server's own post-request multipart cleanup), so eight successful,
// unaccounted 12 MiB spills sit there alongside the eight landed files —
// real disk pressure this test's probe can see but the unfixed handler's
// admission check never did.
func TestUpload_ConcurrentLargeBodiesNeverCrossTheFloor(t *testing.T) {
	tmpDir := redirectProcessTempDir(t)

	const size = 12 << 20 // above the 10 MiB in-memory multipart threshold
	const floor = uint64(50 << 20)
	// Sized so eight racers' bytes landing exactly once (96 MiB total) fit
	// comfortably (150 - 96 = 54 MiB, above the floor): a correct admission
	// scheme can let all eight through. Only counting the same bytes twice
	// (staged and landed) can drive the observed free space under the floor.
	const baseFree = uint64(150 << 20)

	real, err := storage.New(t.TempDir(), 50)
	if err != nil {
		t.Fatal(err)
	}
	var onDisk atomic.Uint64
	h := newQuotaHarness(t, trackedStore{real, &onDisk})

	var minFreeObserved atomic.Uint64
	minFreeObserved.Store(baseFree)
	probe := func(string) (uint64, error) {
		used := onDisk.Load() + dirByteSize(tmpDir)
		free := uint64(0)
		if used < baseFree {
			free = baseFree - used
		}
		for {
			cur := minFreeObserved.Load()
			if free >= cur {
				break
			}
			if minFreeObserved.CompareAndSwap(cur, free) {
				break
			}
		}
		return free, nil
	}
	h.limits(t, 0, floor, probe)

	start := make(chan struct{})
	var wg sync.WaitGroup
	var created, refused, other atomic.Int32
	body := bytes.Repeat([]byte("y"), size)
	for range 8 {
		wg.Go(func() {
			<-start
			rr := doUpload(t, h.router, h.token, "file", "f.bin", body)
			switch rr.Code {
			case http.StatusCreated:
				created.Add(1)
			case http.StatusInsufficientStorage:
				refused.Add(1)
			default:
				other.Add(1)
				t.Errorf("unexpected status %d: %s", rr.Code, rr.Body.String())
			}
		})
	}
	close(start)
	wg.Wait()

	// Eight racers landing 12 MiB each (96 MiB) leaves 150 - 96 = 54 MiB
	// free, above the 50 MiB floor: a correct admission scheme, which
	// serializes every check-and-charge under one lock and counts each
	// byte exactly once (in flight, then landed — never both), admits all
	// eight. Only double-counting staged and landed bytes can produce a
	// different outcome or drive the observed free space under the floor.
	if got := created.Load(); got != 8 {
		t.Fatalf("created %d, refused %d; want all 8 admitted (96 MiB landed leaves 54 MiB, above the 50 MiB floor)", got, refused.Load())
	}
	if created.Load()+refused.Load() != 8 {
		t.Fatalf("created %d, refused %d; want them to add to 8", created.Load(), refused.Load())
	}
	if minFreeObserved.Load() < floor {
		t.Fatalf("the observed free space dropped to %d bytes, under the %d floor", minFreeObserved.Load(), floor)
	}
}
