package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

// B5-2 at the HTTP seam: the two 507 codes, the charge's release on every
// failure path (a failed write, a failed row, a panic after the write), the
// avatar and emoji paths, the concurrent race through the real handler, and
// the structural guard that every store write is reserved. The service-level
// proofs live in service/upload_quota_test.go; these prove the handlers are
// wired to them.

// quotaHarness is an upload router over the real migration set with the
// service in hand, so a test can set storage limits.
type quotaHarness struct {
	database *db.DB
	store    *storage.Storage
	dir      string
	uploads  *service.UploadService
	router   http.Handler
	token    string
	userID   int64
}

func newQuotaHarness(t *testing.T, store api.FileStore) *quotaHarness {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	h := &quotaHarness{database: database, dir: t.TempDir()}
	if store == nil {
		h.store, err = storage.New(h.dir, 10)
		if err != nil {
			t.Fatalf("storage.New: %v", err)
		}
		store = h.store
	}
	h.uploads = service.NewUploadService(database, service.NewPermissionService(database, permissions.NewChecker(database)))
	r := chi.NewRouter()
	api.MountUploadRoutes(r, service.NewSessionService(database), store, auth.NewRateLimiter(), nil, h.uploads)
	h.router = r
	h.token = uploadCreateToken(t, database, "quota_user", int(permissions.MemberRoleID))
	if err := database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'quota_user'`).Scan(&h.userID); err != nil {
		t.Fatalf("user id: %v", err)
	}
	return h
}

func (h *quotaHarness) limits(t *testing.T, quota int64, minFree uint64, free func(string) (uint64, error)) {
	t.Helper()
	h.uploads.SetStorageLimits(service.StorageLimits{UserQuotaBytes: quota, MinFreeBytes: minFree, Dir: h.dir, FreeBytes: free})
}

func (h *quotaHarness) used(t *testing.T) int64 {
	t.Helper()
	n, err := h.uploads.StorageUsed(context.Background(), h.userID)
	if err != nil {
		t.Fatalf("StorageUsed: %v", err)
	}
	return n
}

func (h *quotaHarness) filesOnDisk(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	return len(entries)
}

func assertErrorCode(t *testing.T, rr *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rr.Code != status {
		t.Fatalf("status = %d, want %d; body %s", rr.Code, status, rr.Body.String())
	}
	var body struct{ Error string }
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v: %s", err, rr.Body.String())
	}
	if body.Error != code {
		t.Fatalf("error code = %q, want %q", body.Error, code)
	}
	if strings.Contains(rr.Body.String(), string(filepath.Separator)+"Temp") || strings.Contains(rr.Body.String(), "/tmp") {
		t.Fatalf("507 body leaks a path: %s", rr.Body.String())
	}
}

func TestUploadQuota_ExceededIs507WithItsOwnCode(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limits(t, 1024, 0, nil)
	rr := doUpload(t, h.router, h.token, "file", "big.bin", bytes.Repeat([]byte("x"), 2048))
	assertErrorCode(t, rr, http.StatusInsufficientStorage, "STORAGE_QUOTA_EXCEEDED")
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a refused upload left a file on disk")
	}
	if got := h.used(t); got != 0 {
		t.Fatalf("counter = %d after a refusal, want 0", got)
	}
	rr = doUpload(t, h.router, h.token, "file", "ok.bin", bytes.Repeat([]byte("x"), 1024))
	if rr.Code != http.StatusCreated {
		t.Fatalf("exactly-at-quota upload: %d %s", rr.Code, rr.Body.String())
	}
	if got := h.used(t); got != 1024 {
		t.Fatalf("counter = %d, want 1024", got)
	}
}

// TestUploadQuota_LowDiskIs507BeforeTheBodyIsSpooled: the floor refuses on
// the declared length before the multipart parser spools anything, so a
// full volume gets no temp file either.
func TestUploadQuota_LowDiskIs507BeforeTheBodyIsSpooled(t *testing.T) {
	h := newQuotaHarness(t, nil)
	var probes atomic.Int32
	h.limits(t, 0, 256<<20, func(string) (uint64, error) { probes.Add(1); return 100 << 20, nil })
	rr := doUpload(t, h.router, h.token, "file", "f.bin", []byte("hello"))
	assertErrorCode(t, rr, http.StatusInsufficientStorage, "STORAGE_LOW_DISK")
	if probes.Load() != 1 {
		t.Fatalf("probe ran %d times; the Content-Length check should refuse before any Reserve", probes.Load())
	}
	if h.filesOnDisk(t) != 0 || h.used(t) != 0 {
		t.Fatal("a floor refusal wrote or charged something")
	}
	// The order is the point: a body the multipart parser would reject (400)
	// still gets the floor's 507 first, because the floor is checked on the
	// declared length before the parser ever touches the body.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", bytes.NewReader([]byte("not multipart at all")))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=nope")
	req.Header.Set("Authorization", "Bearer "+h.token)
	rr = httptest.NewRecorder()
	h.router.ServeHTTP(rr, req)
	assertErrorCode(t, rr, http.StatusInsufficientStorage, "STORAGE_LOW_DISK")
}

// TestUploadQuota_ConcurrentRacersThroughTheHandler drives the exactly-k
// proof through the real route under -race: eight parallel POSTs (under the
// ten-per-minute limiter) with room for three.
func TestUploadQuota_ConcurrentRacersThroughTheHandler(t *testing.T) {
	const size = 1000
	h := newQuotaHarness(t, nil)
	h.limits(t, 3*size, 0, nil)
	start := make(chan struct{})
	var wg sync.WaitGroup
	var created, refused, other atomic.Int32
	for range 8 {
		wg.Go(func() {
			<-start
			rr := doUpload(t, h.router, h.token, "file", "f.bin", bytes.Repeat([]byte("y"), size))
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
	if created.Load() != 3 || refused.Load() != 5 {
		t.Fatalf("created %d, refused %d; want exactly 3 and 5", created.Load(), refused.Load())
	}
	if got := h.used(t); got != 3*size {
		t.Fatalf("counter = %d, want %d", got, 3*size)
	}
	if h.filesOnDisk(t) != 3 {
		t.Fatalf("%d files on disk, want 3", h.filesOnDisk(t))
	}
}

// TestUploadQuota_ChargeReleasedWhenTheWriteFails: a blocked file type is
// refused by the store after the charge; the charge comes back.
func TestUploadQuota_ChargeReleasedWhenTheWriteFails(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limits(t, 1<<20, 0, nil)
	rr := doUpload(t, h.router, h.token, "file", "evil.exe", append([]byte("MZ"), make([]byte, 100)...))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("blocked type: %d %s", rr.Code, rr.Body.String())
	}
	if got := h.used(t); got != 0 {
		t.Fatalf("counter = %d after a failed write, want 0", got)
	}
}

// TestUploadQuota_ChargeReleasedWhenTheRowFails: the file is written, the
// row insert fails, the file is removed and the charge comes back.
func TestUploadQuota_ChargeReleasedWhenTheRowFails(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limits(t, 1<<20, 0, nil)
	if _, err := h.database.ExecContext(context.Background(), `DROP TABLE attachments`); err != nil {
		t.Fatal(err)
	}
	rr := doUpload(t, h.router, h.token, "file", "f.bin", []byte("payload"))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("row failure: %d %s", rr.Code, rr.Body.String())
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("the orphan file was not removed")
	}
	if got := h.used(t); got != 0 {
		t.Fatalf("counter = %d after a failed row, want 0", got)
	}
}

// panicOnOpen is a FileStore whose Open panics: the image path opens the
// file for its dimensions right after Save, which puts the panic between the
// write and the row — the leak the deferred Settle exists for.
type panicOnOpen struct{ api.FileStore }

func (panicOnOpen) Open(string) (storage.File, error) {
	panic("simulated crash between Save and Record")
}

// TestUploadQuota_ChargeReleasedOnPanicAfterTheWrite: nothing reaches Record,
// and the counter is still returned by the deferred Settle.
func TestUploadQuota_ChargeReleasedOnPanicAfterTheWrite(t *testing.T) {
	real, err := storage.New(t.TempDir(), 10)
	if err != nil {
		t.Fatal(err)
	}
	h := newQuotaHarness(t, panicOnOpen{real})
	h.limits(t, 1<<20, 0, nil)
	body, contentType := makeMultipartFile(t, "file", "img.png", makePNGBytes(t, 4, 4))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+h.token)
	rr := httptest.NewRecorder()
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("expected the simulated panic to propagate")
			}
		}()
		h.router.ServeHTTP(rr, req)
	}()
	if got := h.used(t); got != 0 {
		t.Fatalf("counter = %d after a panic between Save and Record, want 0 (Settle must run on unwind)", got)
	}
}

// TestAvatarUpload_IsChargedAndQuotaGated: an avatar is an attachment and
// counts against its uploader's quota.
func TestAvatarUpload_IsChargedAndQuotaGated(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	store, err := storage.New(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	r := chi.NewRouter()
	api.MountProfileRoutes(r, database, svc, store, limiter, nil, nil)
	token := uploadCreateToken(t, database, "avatar_user", int(permissions.MemberRoleID))
	var userID int64
	if err := database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'avatar_user'`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	png := makePNGBytes(t, 8, 8)
	post := func() *httptest.ResponseRecorder {
		body, contentType := makeMultipartFile(t, "file", "me.png", png)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar", body)
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("Authorization", "Bearer "+token)
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}
	svc.Uploads.SetStorageLimits(service.StorageLimits{UserQuotaBytes: int64(len(png)), Dir: dir})
	if rr := post(); rr.Code != http.StatusCreated {
		t.Fatalf("avatar at quota: %d %s", rr.Code, rr.Body.String())
	}
	used, err := svc.Uploads.StorageUsed(context.Background(), userID)
	if err != nil || used != int64(len(png)) {
		t.Fatalf("counter = %d, %v; want %d", used, err, len(png))
	}
	assertErrorCode(t, post(), http.StatusInsufficientStorage, "STORAGE_QUOTA_EXCEEDED")
}

// TestEmojiUpload_IsFloorGatedButNotCharged: emoji go through the headroom
// floor and nothing else — the bounded exclusion, proved at the route.
func TestEmojiUpload_IsFloorGatedButNotCharged(t *testing.T) {
	h := newEmojiHarness(t)
	png := makePNGBytes(t, 8, 8)
	h.svc.Uploads.SetStorageLimits(service.StorageLimits{MinFreeBytes: 256 << 20, Dir: t.TempDir(), FreeBytes: func(string) (uint64, error) { return 100 << 20, nil }})
	assertErrorCode(t, h.upload(t, h.adminToken, "wave", png), http.StatusInsufficientStorage, "STORAGE_LOW_DISK")
	h.svc.Uploads.SetStorageLimits(service.StorageLimits{UserQuotaBytes: 1, Dir: t.TempDir()})
	if rr := h.upload(t, h.adminToken, "wave", png); rr.Code != http.StatusCreated {
		t.Fatalf("emoji under a 1-byte quota: %d %s (emoji are excluded from the quota)", rr.Code, rr.Body.String())
	}
	var adminID int64
	if err := h.database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'admin'`).Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	if used, err := h.svc.Uploads.StorageUsed(context.Background(), adminID); err != nil || used != 0 {
		t.Fatalf("emoji charged the uploader: %d, %v", used, err)
	}
}

// TestUploadQuota_RestoreWithoutStorageDirRowsOutliveFiles is the test B5-0's
// abuse table owed: a database restored without upload.storage_dir names
// files that are not there. The row survives, the file 404s, and the counter
// keeps charging the row — the safe side — until the operator reconciles.
func TestUploadQuota_RestoreWithoutStorageDirRowsOutliveFiles(t *testing.T) {
	h := newQuotaHarness(t, nil)
	h.limits(t, 0, 0, nil)
	rr := doUpload(t, h.router, h.token, "file", "f.bin", []byte("survives in the database only"))
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rr.Code, rr.Body.String())
	}
	var resp struct{ ID string }
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	// The restore: the database is intact, the upload directory is not.
	if err := os.RemoveAll(h.dir); err != nil {
		t.Fatal(err)
	}
	if rr := doServeFile(t, h.router, resp.ID, h.token, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("serving a row with no file: %d, want 404", rr.Code)
	}
	var rows int
	if err := h.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM attachments WHERE id = ?`, resp.ID).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("attachment row after the restore: %d, %v; want it to survive", rows, err)
	}
	if got := h.used(t); got == 0 {
		t.Fatal("counter dropped a row whose file is missing; the row is the truth until it is deleted")
	}
	if _, err := h.uploads.RecountStorage(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := h.used(t); got == 0 {
		t.Fatal("recount dropped a row whose file is missing")
	}
}

// TestHandleMetrics_StoragePressureFields: disk_free_mb is extended, not
// joined by an endpoint — the floor, the pressure bit and the storage total.
func TestHandleMetrics_StoragePressureFields(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/v1/metrics", api.HandleMetricsForTest(api.MetricsSources{
		DiskFree:    func() (uint64, error) { return 100 << 20, nil },
		DiskMinFree: 256 << 20,
		UploadBytes: func(context.Context) (int64, error) { return 3 << 20, nil },
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	var m struct {
		DiskFreeMB          float64  `json:"disk_free_mb"`
		DiskMinFreeMB       float64  `json:"disk_min_free_mb"`
		DiskLow             *bool    `json:"disk_low"`
		UploadStorageUsedMB *float64 `json:"upload_storage_used_mb"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatalf("metrics body: %v", err)
	}
	if m.DiskFreeMB != 100 || m.DiskMinFreeMB != 256 {
		t.Fatalf("disk_free_mb=%v disk_min_free_mb=%v", m.DiskFreeMB, m.DiskMinFreeMB)
	}
	if m.DiskLow == nil || !*m.DiskLow {
		t.Fatal("disk_low should be true with 100 MiB free under a 256 MiB floor")
	}
	if m.UploadStorageUsedMB == nil || *m.UploadStorageUsedMB != 3 {
		t.Fatalf("upload_storage_used_mb = %v, want 3", m.UploadStorageUsedMB)
	}
}

// TestEveryFileStoreSaveIsReserved is the structural half of decision 11:
// production code writes through a FileStore in exactly one place,
// saveReserved, whose signature demands a reservation. It walks every
// non-test .go file under Server/ that could hold a FileStore — one that
// names the type or imports the storage package — and fails on any other
// `.Save(` call. A call through an imported package (config.Save) is not a
// method on a value and is skipped by construction, not by allowlist.
//
// What this proves is "no second FileStore.Save call site". A write that
// bypasses the store altogether (os.WriteFile into the upload directory) is
// outside it; the absence of such a writer at HEAD is recorded in the plan's
// evidence, not enforced here.
func TestEveryFileStoreSaveIsReserved(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	scanned, candidates := 0, 0
	var offenders []string
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "vendor" || name == "testdata" || name == "dbgen" || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		scanned++
		if !mentionsFileStore(f) {
			return nil
		}
		candidates++
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		imports := importNames(f)
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Save" || len(call.Args) != 2 {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && imports[id.Name] {
				return true // pkg.Save(...): a function, not a store method
			}
			if rel == "api/filestore.go" && enclosingFunc(f, call.Pos()) == "saveReserved" {
				return true
			}
			offenders = append(offenders, rel+":"+fset.Position(call.Pos()).String())
			return true
		})
		return nil
	})
	if walkErr != nil {
		t.Fatal(walkErr)
	}
	if scanned < 100 || candidates < 3 {
		t.Fatalf("scanned %d files, %d candidates — this gate would pass vacuously", scanned, candidates)
	}
	if len(offenders) > 0 {
		t.Fatalf("FileStore.Save called outside saveReserved (unreserved store writes):\n  %s", strings.Join(offenders, "\n  "))
	}
}

// mentionsFileStore reports whether f names the FileStore type or imports the
// storage package — the two ways a file can hold a store to write through.
func mentionsFileStore(f *ast.File) bool {
	for _, imp := range f.Imports {
		if strings.Trim(imp.Path.Value, `"`) == "github.com/J3vb/OwnCord/Server/storage" {
			return true
		}
	}
	found := false
	ast.Inspect(f, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && id.Name == "FileStore" {
			found = true
			return false
		}
		return !found
	})
	return found
}

func importNames(f *ast.File) map[string]bool {
	names := map[string]bool{}
	for _, imp := range f.Imports {
		p := strings.Trim(imp.Path.Value, `"`)
		name := p[strings.LastIndex(p, "/")+1:]
		if imp.Name != nil {
			name = imp.Name.Name
		}
		names[name] = true
	}
	return names
}

func enclosingFunc(f *ast.File, pos token.Pos) string {
	for _, d := range f.Decls {
		if fn, ok := d.(*ast.FuncDecl); ok && fn.Pos() <= pos && pos <= fn.End() {
			return fn.Name.Name
		}
	}
	return ""
}
