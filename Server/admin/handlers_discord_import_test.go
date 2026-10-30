package admin_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/service/discordimport"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

const importFixturePath = "../service/discordimport/testdata/channel.json"

// gatedStore holds the first chunk write until released, so a test can act
// while an import is running.
type gatedStore struct {
	*db.DB
	reached chan struct{}
	release chan struct{}
	once    sync.Once
}

func (g *gatedStore) ImportChunk(ctx context.Context, p db.ImportChunkParams) (map[string]int64, error) {
	g.once.Do(func() { close(g.reached) })
	select {
	case <-g.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return g.DB.ImportChunk(ctx, p)
}

type channelRecorder struct {
	mu      sync.Mutex
	created []int64
}

func (c *channelRecorder) BroadcastChannelCreate(ch *db.Channel) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.created = append(c.created, ch.ID)
}

func (c *channelRecorder) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.created)
}

type importFixture struct {
	handler  http.Handler
	database *db.DB
	token    string
	dir      string
	gate     *gatedStore
	ann      *channelRecorder
	audits   *audittest.Recorder
}

// newImportFixture serves the admin API over a fully migrated database with a
// real runner. maxBytes 0 keeps the default cap.
func newImportFixture(t *testing.T, maxBytes int64) *importFixture {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	files, err := storage.New(t.TempDir(), 10)
	if err != nil {
		t.Fatal(err)
	}
	group := syncutil.NewGroup(context.Background())
	t.Cleanup(func() { group.Stop(context.Background(), 5*time.Second) })

	f := &importFixture{
		database: database,
		dir:      t.TempDir(),
		ann:      &channelRecorder{},
		gate:     &gatedStore{DB: database, reached: make(chan struct{}), release: make(chan struct{})},
	}
	runner := discordimport.NewService(discordimport.ServiceConfig{
		Store:   f.gate,
		Files:   api.ReservedStore{Store: files},
		Uploads: service.NewUploadService(database, nil),
		Hub:     f.ann,
		Group:   group,
	})
	f.token = createAdminUser(t, database)
	f.audits = audittest.Install(t, database)
	f.handler = admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{},
		newTestServices(database), admin.SetupOptions{
			DiscordImport: runner, ImportDir: f.dir, ImportMaxBytes: maxBytes, Background: group,
		})
	return f
}

// open lets the gated chunk write through.
func (f *importFixture) open() { close(f.gate.release) }

func (f *importFixture) do(t *testing.T, method, path, token string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	return w
}

func (f *importFixture) upload(t *testing.T, query string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, http.MethodPost, "/discord-imports/upload?"+query, f.token, body)
}

func readFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(importFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type jobBody struct {
	ID                 int64   `json:"id"`
	Status             string  `json:"status"`
	Imported           int64   `json:"imported"`
	Skipped            int64   `json:"skipped"`
	SkippedAttachments int64   `json:"skipped_attachments"`
	Error              *string `json:"error"`
}

func decodeJob(t *testing.T, w *httptest.ResponseRecorder) jobBody {
	t.Helper()
	var j jobBody
	if err := json.Unmarshal(w.Body.Bytes(), &j); err != nil {
		t.Fatalf("decode job: %v (%s)", err, w.Body.String())
	}
	return j
}

// waitStatus polls the status route until the job leaves running.
func (f *importFixture) waitStatus(t *testing.T, id int64) jobBody {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		w := f.do(t, http.MethodGet, "/discord-imports/"+strconv.FormatInt(id, 10), f.token, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("status route = %d: %s", w.Code, w.Body.String())
		}
		if j := decodeJob(t, w); j.Status != db.ImportRunning {
			return j
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("import did not finish")
	return jobBody{}
}

// waitEmptyDir waits for the background clean-up to remove the upload.
func (f *importFixture) waitEmptyDir(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if entries, err := os.ReadDir(f.dir); err == nil && len(entries) == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	entries, _ := os.ReadDir(f.dir)
	t.Fatalf("upload directory still holds %d file(s)", len(entries))
}

func TestDiscordImport_JSONUploadEndsInAPublishedChannel(t *testing.T) {
	f := newImportFixture(t, 0)
	f.open()
	w := f.upload(t, "filename=general.json&category_id=0", readFixture(t))
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}
	job := decodeJob(t, w)
	got := f.waitStatus(t, job.ID)
	if got.Status != db.ImportDone || got.Imported != 4 || got.Skipped != 3 || got.Error != nil {
		t.Fatalf("job = %+v, want done with 4 imported and 3 skipped", got)
	}
	row, err := f.database.GetImportJob(context.Background(), job.ID)
	if err != nil || row.ChannelID == nil {
		t.Fatalf("job row = %+v, %v", row, err)
	}
	ch, err := f.database.GetChannel(context.Background(), *row.ChannelID)
	if err != nil || ch == nil || ch.Name != "general" {
		t.Fatalf("published channel = %+v, %v", ch, err)
	}
	if f.ann.count() != 1 {
		t.Errorf("announced %d channels, want exactly 1", f.ann.count())
	}
	f.waitEmptyDir(t)

	start := f.audits.Wait(t, "discord_import_start")
	if start.TargetID != *row.ChannelID || !strings.Contains(start.Detail, "general.json") {
		t.Errorf("start audit = %+v", start)
	}
	pub := f.audits.Wait(t, "discord_import_publish")
	if !strings.Contains(pub.Detail, "4 messages imported") {
		t.Errorf("publish audit detail = %q", pub.Detail)
	}

	w = f.do(t, http.MethodGet, "/discord-imports/latest", f.token, nil)
	var latest struct {
		Job            jobBody `json:"job"`
		RetentionDays  int     `json:"retention_days"`
		MaxUploadBytes int64   `json:"max_upload_bytes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &latest); err != nil || w.Code != http.StatusOK {
		t.Fatalf("latest = %d %s (%v)", w.Code, w.Body.String(), err)
	}
	if latest.Job.ID != job.ID || latest.MaxUploadBytes != admin.DefaultImportMaxBytes {
		t.Errorf("latest = %+v", latest)
	}
}

func TestDiscordImport_ZipUploadIsAccepted(t *testing.T) {
	f := newImportFixture(t, 0)
	f.open()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	entry, err := zw.Create("channel.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write(readFixture(t)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	w := f.upload(t, "filename=export.ZIP", buf.Bytes())
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}
	if got := f.waitStatus(t, decodeJob(t, w).ID); got.Status != db.ImportDone || got.Imported != 4 {
		t.Fatalf("job = %+v", got)
	}
	f.waitEmptyDir(t)
}

func TestDiscordImport_RejectsBadUploads(t *testing.T) {
	f := newImportFixture(t, 0)
	f.open()
	cases := []struct {
		name  string
		query string
		body  []byte
		want  int
	}{
		{"wrong extension", "filename=export.txt", []byte("x"), http.StatusBadRequest},
		{"no filename", "category_id=0", []byte("x"), http.StatusBadRequest},
		{"bad category id", "filename=a.json&category_id=abc", []byte("x"), http.StatusBadRequest},
		{"negative category id", "filename=a.json&category_id=-3", []byte("x"), http.StatusBadRequest},
		{"unknown category", "filename=a.json&category_id=9999", readFixture(t), http.StatusBadRequest},
		{"empty body", "filename=a.json", nil, http.StatusBadRequest},
		{"not a zip", "filename=a.zip", []byte("this is not a zip"), http.StatusBadRequest},
		{"not an export", "filename=a.json", []byte(`{"hello":"world"}`), http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if w := f.upload(t, tc.query, tc.body); w.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			f.waitEmptyDir(t)
		})
	}
	var n int
	if err := f.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM import_jobs`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rejected uploads left %d job rows (%v)", n, err)
	}
}

func TestDiscordImport_OverTheCapIs413AndLeavesNothing(t *testing.T) {
	f := newImportFixture(t, 64)
	body := readFixture(t)

	t.Run("declared length", func(t *testing.T) {
		if w := f.upload(t, "filename=a.json", body); w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413: %s", w.Code, w.Body.String())
		}
		f.waitEmptyDir(t)
	})
	t.Run("undeclared length", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/discord-imports/upload?filename=a.json", bytes.NewReader(body))
		req.ContentLength = -1
		req.Header.Set("Authorization", "Bearer "+f.token)
		w := httptest.NewRecorder()
		f.handler.ServeHTTP(w, req)
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413: %s", w.Code, w.Body.String())
		}
		f.waitEmptyDir(t)
	})
}

func TestDiscordImport_SecondImportWhileRunningIs409(t *testing.T) {
	f := newImportFixture(t, 0)
	w := f.upload(t, "filename=a.json", readFixture(t))
	if w.Code != http.StatusAccepted {
		t.Fatalf("first upload = %d: %s", w.Code, w.Body.String())
	}
	first := decodeJob(t, w)
	<-f.gate.reached

	if w := f.upload(t, "filename=b.json", readFixture(t)); w.Code != http.StatusConflict {
		t.Fatalf("second upload = %d, want 409: %s", w.Code, w.Body.String())
	}
	f.open()
	if got := f.waitStatus(t, first.ID); got.Status != db.ImportDone {
		t.Fatalf("first job = %+v", got)
	}
	f.waitEmptyDir(t)
	// With the first one over, the next import is accepted.
	if w := f.upload(t, "filename=c.json", readFixture(t)); w.Code != http.StatusAccepted {
		t.Fatalf("third upload = %d: %s", w.Code, w.Body.String())
	}
}

func TestDiscordImport_CancelEndsTheJobAndRemovesTheChannel(t *testing.T) {
	f := newImportFixture(t, 0)
	w := f.upload(t, "filename=a.json", readFixture(t))
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}
	job := decodeJob(t, w)
	<-f.gate.reached

	id := strconv.FormatInt(job.ID, 10)
	if w := f.do(t, http.MethodPost, "/discord-imports/"+id+"/cancel", f.token, nil); w.Code != http.StatusAccepted {
		t.Fatalf("cancel = %d: %s", w.Code, w.Body.String())
	}
	got := f.waitStatus(t, job.ID)
	if got.Status != db.ImportCancelled {
		t.Fatalf("job = %+v, want cancelled", got)
	}
	var channels int
	if err := f.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM channels WHERE name = 'general'`).Scan(&channels); err != nil || channels != 0 {
		t.Errorf("cancelled import left %d channels (%v)", channels, err)
	}
	f.waitEmptyDir(t)
	f.audits.Wait(t, "discord_import_cancel")

	if w := f.do(t, http.MethodPost, "/discord-imports/"+id+"/cancel", f.token, nil); w.Code != http.StatusConflict {
		t.Errorf("cancel of a finished job = %d, want 409", w.Code)
	}
	if w := f.do(t, http.MethodPost, "/discord-imports/9999/cancel", f.token, nil); w.Code != http.StatusNotFound {
		t.Errorf("cancel of an unknown job = %d, want 404", w.Code)
	}
	if w := f.do(t, http.MethodPost, "/discord-imports/abc/cancel", f.token, nil); w.Code != http.StatusBadRequest {
		t.Errorf("cancel with a bad id = %d, want 400", w.Code)
	}
}

func TestDiscordImport_StatusAndLatestWhenNothingRan(t *testing.T) {
	f := newImportFixture(t, 0)
	if w := f.do(t, http.MethodGet, "/discord-imports/77", f.token, nil); w.Code != http.StatusNotFound {
		t.Errorf("unknown id = %d, want 404", w.Code)
	}
	if w := f.do(t, http.MethodGet, "/discord-imports/0", f.token, nil); w.Code != http.StatusBadRequest {
		t.Errorf("id 0 = %d, want 400", w.Code)
	}
	w := f.do(t, http.MethodGet, "/discord-imports/latest", f.token, nil)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != http.StatusOK {
		t.Fatalf("latest = %d %s (%v)", w.Code, w.Body.String(), err)
	}
	if v, present := out["job"]; !present || v != nil {
		t.Errorf("job = %v (present %v), want null", v, present)
	}
}

func TestDiscordImport_LatestReportsTheRetentionWindow(t *testing.T) {
	f := newImportFixture(t, 0)
	if _, err := f.database.ExecContext(context.Background(),
		`INSERT INTO settings (key, value) VALUES ('retention_days', '30') ON CONFLICT(key) DO UPDATE SET value = excluded.value`); err != nil {
		t.Fatal(err)
	}
	svc := newTestServices(f.database)
	svc.Retention = service.NewRetentionService(f.database)
	h := admin.NewAdminAPI(f.database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{}, svc,
		admin.SetupOptions{DiscordImport: &stubImporter{}})
	req := httptest.NewRequest(http.MethodGet, "/discord-imports/latest", nil)
	req.Header.Set("Authorization", "Bearer "+f.token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var out struct {
		RetentionDays int `json:"retention_days"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.RetentionDays != 30 {
		t.Fatalf("latest = %s (%v), want retention_days 30", w.Body.String(), err)
	}
}

// stubImporter answers every start with the error it is given.
type stubImporter struct{ startErr error }

func (s *stubImporter) Start(context.Context, discordimport.Request) (*discordimport.Job, error) {
	return nil, s.startErr
}
func (*stubImporter) Running(int64) *discordimport.Job           { return nil }
func (*stubImporter) Cancel(context.Context, int64, int64) error { return discordimport.ErrNotFound }
func (*stubImporter) Status(context.Context, int64) (discordimport.JobView, error) {
	return discordimport.JobView{}, discordimport.ErrNotFound
}
func (*stubImporter) Latest(context.Context) (discordimport.JobView, error) {
	return discordimport.JobView{}, discordimport.ErrNotFound
}
func (*stubImporter) CategoryExists(context.Context, int64) (bool, error) { return true, nil }

func TestDiscordImport_StartRefusalsMapToStatuses(t *testing.T) {
	database := openAdminTestDB(t)
	token := createAdminUser(t, database)
	for name, tc := range map[string]struct {
		err  error
		want int
	}{
		"another import runs": {discordimport.ErrImportRunning, http.StatusConflict},
		"server stopping":     {discordimport.ErrShuttingDown, http.StatusServiceUnavailable},
		"unexpected":          {errors.New("boom"), http.StatusInternalServerError},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			h := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{},
				newTestServices(database), admin.SetupOptions{DiscordImport: &stubImporter{startErr: tc.err}, ImportDir: dir})
			req := httptest.NewRequest(http.MethodPost, "/discord-imports/upload?filename=a.json", bytes.NewReader(readFixture(t)))
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 0 {
				t.Errorf("a refused start left %d file(s) behind", len(entries))
			}
		})
	}
}

func TestDiscordImport_UnavailableWithoutARunner(t *testing.T) {
	database := openAdminTestDB(t)
	token := createAdminUser(t, database)
	h := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{}, newTestServices(database))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/discord-imports/latest"},
		{http.MethodGet, "/discord-imports/1"},
		{http.MethodPost, "/discord-imports/1/cancel"},
		{http.MethodPost, "/discord-imports/upload?filename=a.json"},
	} {
		if w := doRequest(t, h, tc.method, tc.path, token, nil); w.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s = %d, want 503", tc.method, tc.path, w.Code)
		}
	}
}

func TestDiscordImport_RoutesRequireManageChannels(t *testing.T) {
	f := newImportFixture(t, 0)
	member := createUserWithRole(t, f.database, "plainmember", 4)
	routes := []struct{ method, path string }{
		{http.MethodGet, "/discord-imports/latest"},
		{http.MethodGet, "/discord-imports/1"},
		{http.MethodPost, "/discord-imports/1/cancel"},
		{http.MethodPost, "/discord-imports/upload?filename=a.json"},
	}
	for _, rt := range routes {
		if w := f.do(t, rt.method, rt.path, member, readFixture(t)); w.Code != http.StatusForbidden {
			t.Errorf("member %s %s = %d, want 403", rt.method, rt.path, w.Code)
		}
		if w := f.do(t, rt.method, rt.path, "", nil); w.Code != http.StatusUnauthorized {
			t.Errorf("anonymous %s %s = %d, want 401", rt.method, rt.path, w.Code)
		}
	}
	var n int
	if err := f.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM import_jobs`).Scan(&n); err != nil || n != 0 {
		t.Errorf("refused callers started %d jobs (%v)", n, err)
	}
	f.waitEmptyDir(t)

	_, mod := createRoleUser(t, f.database, 90, "ChannelManager", 0x20000, 50, "chanmgr")
	if w := f.do(t, http.MethodGet, "/discord-imports/latest", mod, nil); w.Code != http.StatusOK {
		t.Errorf("a MANAGE_CHANNELS holder = %d, want 200", w.Code)
	}
	_, other := createRoleUser(t, f.database, 91, "Muter", 0x100000, 49, "muter")
	if w := f.do(t, http.MethodGet, "/discord-imports/latest", other, nil); w.Code != http.StatusForbidden {
		t.Errorf("a role without MANAGE_CHANNELS = %d, want 403", w.Code)
	}
}

func TestDiscordImport_BadCategoryIsRefusedBeforeTheBodyIsRead(t *testing.T) {
	// The cap is below the body, so reading it would have answered 413.
	f := newImportFixture(t, 64)
	if w := f.upload(t, "filename=a.json&category_id=9999", readFixture(t)); w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body.String())
	}
	f.waitEmptyDir(t)
}

func TestDiscordImport_RefusesAnUploadTheDiskCannotHold(t *testing.T) {
	database := openAdminTestDB(t)
	token := createAdminUser(t, database)
	dir := t.TempDir()
	h := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{},
		newTestServices(database), admin.SetupOptions{DiscordImport: &stubImporter{}, ImportDir: dir, ImportMaxBytes: 1 << 60})
	// No declared length, so the whole cap is what must fit.
	req := httptest.NewRequest(http.MethodPost, "/discord-imports/upload?filename=a.json", bytes.NewReader(readFixture(t)))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusInsufficientStorage || !strings.Contains(w.Body.String(), "STORAGE_LOW_DISK") {
		t.Fatalf("status = %d, want 507 STORAGE_LOW_DISK: %s", w.Code, w.Body.String())
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("a refused upload left %d file(s)", len(entries))
	}
}

func TestDiscordImport_TransferLifetimeScalesWithTheCap(t *testing.T) {
	database := openAdminTestDB(t)
	token := createAdminUser(t, database)
	for _, tc := range []struct {
		max  int64
		want time.Duration
	}{
		{1 << 20, 10 * time.Minute},
		{500 << 20, 2048 * time.Second},
	} {
		var got time.Duration
		released := false
		h := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{},
			newTestServices(database), admin.SetupOptions{
				DiscordImport: &stubImporter{startErr: errors.New("stop")}, ImportDir: t.TempDir(), ImportMaxBytes: tc.max,
				BeginTransfer: func(w http.ResponseWriter, r *http.Request, maxBytes int64, lifetime time.Duration) (io.ReadCloser, func()) {
					got = lifetime
					return http.MaxBytesReader(w, r.Body, maxBytes), func() { released = true }
				},
			})
		req := httptest.NewRequest(http.MethodPost, "/discord-imports/upload?filename=a.json", bytes.NewReader([]byte("{}")))
		req.Header.Set("Authorization", "Bearer "+token)
		h.ServeHTTP(httptest.NewRecorder(), req)
		if got != tc.want || !released {
			t.Errorf("cap %d: lifetime = %v released = %v, want %v released", tc.max, got, released, tc.want)
		}
	}
}
