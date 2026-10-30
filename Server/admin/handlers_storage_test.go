package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// lockedStore is a real upload directory where removing one named file fails,
// as a file another process holds open does on Windows.
// onDelete, when set, runs before each delete.
type lockedStore struct {
	*storage.Storage
	locked   string
	onDelete func()
}

func (s *lockedStore) Delete(name string) error {
	if s.onDelete != nil {
		s.onDelete()
	}
	if name == s.locked {
		return errors.New("file is in use")
	}
	return s.Storage.Delete(name)
}

type storageFixture struct {
	database *db.DB
	handler  http.Handler
	files    *storage.Storage
	store    *lockedStore
	dir      string
	owner    int64
	member   int64
	token    string
	mToken   string
}

func newStorageFixture(t *testing.T, locked string) *storageFixture {
	t.Helper()
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	dir := t.TempDir()
	files, err := storage.New(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	f := &storageFixture{database: database, files: files, store: &lockedStore{Storage: files, locked: locked}, dir: dir}
	f.owner, f.token = sessionFor(t, database, "st-owner", 1)
	f.member, f.mToken = sessionFor(t, database, "st-member", 4)
	f.handler = admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc,
		admin.SetupOptions{UploadFiles: f.store, BackupDir: filepath.Join(dir, "backups")})
	return f
}

// upload stores a file of n bytes for the member and its attachment row.
func (f *storageFixture) upload(t *testing.T, id string, n int) {
	t.Helper()
	if _, err := f.files.Save(id, strings.NewReader(strings.Repeat("x", n))); err != nil {
		t.Fatal(err)
	}
	if err := f.database.CreateAttachment(context.Background(), id, f.member, id+".bin", id, "application/octet-stream", int64(n), nil, nil); err != nil {
		t.Fatal(err)
	}
}

func (f *storageFixture) deleteFiles(t *testing.T, ctx context.Context, ids ...string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string][]string{"ids": ids})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/storage/files/delete", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func ids(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func TestStorage_RoutesNeedManageServer(t *testing.T) {
	f := newStorageFixture(t, "")
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/storage/summary"}, {http.MethodGet, "/storage/files"}, {http.MethodPost, "/storage/files/delete"},
		{http.MethodGet, "/storage/leftovers"}, {http.MethodPost, "/storage/leftovers"}, {http.MethodGet, "/storage/members"},
		{http.MethodPatch, "/users/1/upload-limit"},
	} {
		if w := doRequest(t, f.handler, r.method, r.path, f.mToken, map[string]any{}); w.Code != http.StatusForbidden {
			t.Errorf("member %s %s = %d, want 403", r.method, r.path, w.Code)
		}
	}
}

// A bulk delete whose client hangs up after the first file, with one file that
// cannot leave the disk: every file is still handled, the answer says which, and
// the stuck bytes are counted as kept.
func TestStorage_BulkDeleteFinishesWhenCancelledAndReportsKeptFiles(t *testing.T) {
	f := newStorageFixture(t, "f-locked")
	for _, id := range []string{"f-a", "f-b", "f-locked"} {
		f.upload(t, id, 100)
	}
	ctx, cancel := context.WithCancel(context.Background())
	f.store.onDelete = cancel
	w, out := f.deleteFiles(t, ctx, "f-a", "f-b", "f-locked", "f-a", "f-missing")
	if w.Code != http.StatusOK {
		t.Fatalf("delete = %d: %s", w.Code, w.Body.String())
	}
	if got := ids(out["deleted"]); len(got) != 3 {
		t.Errorf("deleted = %v, want the three real files", got)
	}
	if got := ids(out["already_gone"]); len(got) != 1 || got[0] != "f-missing" {
		t.Errorf("already_gone = %v, want f-missing", got)
	}
	if out["files_kept"].(float64) != 1 || out["freed_bytes"].(float64) != 300 {
		t.Errorf("files_kept %v freed %v, want 1 and 300", out["files_kept"], out["freed_bytes"])
	}
	for id, want := range map[string]bool{"f-a": false, "f-b": false, "f-locked": true} {
		_, err := os.Stat(filepath.Join(f.dir, id))
		if exists := err == nil; exists != want {
			t.Errorf("%s on disk = %v, want %v", id, exists, want)
		}
	}
	var audits int
	if err := f.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM audit_log WHERE action = 'upload_delete'`).Scan(&audits); err != nil || audits != 3 {
		t.Errorf("upload_delete audits = %d, %v; want 3", audits, err)
	}

	if w, _ := f.deleteFiles(t, context.Background()); w.Code != http.StatusBadRequest {
		t.Errorf("empty ids = %d, want 400", w.Code)
	}
	tooMany := make([]string, service.AdminRemoveMaxFiles+1)
	for i := range tooMany {
		tooMany[i] = "id-" + itoa(int64(i))
	}
	if w, _ := f.deleteFiles(t, context.Background(), tooMany...); w.Code != http.StatusBadRequest {
		t.Errorf("%d ids = %d, want 400", len(tooMany), w.Code)
	}
}

func TestStorage_SummaryListLimitAndLeftovers(t *testing.T) {
	f := newStorageFixture(t, "")
	f.upload(t, "big", 300)
	f.upload(t, "small", 20)

	w := doRequest(t, f.handler, http.MethodGet, "/storage/summary", f.token, nil)
	var sum map[string]any
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &sum) != nil || sum["upload_bytes"].(float64) != 320 || sum["upload_count"].(float64) != 2 {
		t.Fatalf("summary = %d %s", w.Code, w.Body.String())
	}

	w = doRequest(t, f.handler, http.MethodGet, "/storage/files?sort=largest&limit=1", f.token, nil)
	var page struct {
		Items []struct {
			Attachment struct{ ID string } `json:"attachment"`
			Uploader   string              `json:"uploader"`
		} `json:"items"`
		NextCursor string `json:"next_cursor"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Items) != 1 || page.Items[0].Attachment.ID != "big" || page.Items[0].Uploader != "st-member" || page.NextCursor == "" {
		t.Fatalf("files = %d %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, f.handler, http.MethodGet, "/storage/files?uploader=x", f.token, nil); w.Code != http.StatusBadRequest {
		t.Errorf("uploader=x = %d, want 400", w.Code)
	}

	if w := doRequest(t, f.handler, http.MethodPatch, "/users/"+itoa(f.member)+"/upload-limit", f.token, map[string]any{"quota_mb": 5}); w.Code != http.StatusOK {
		t.Fatalf("set limit = %d %s", w.Code, w.Body.String())
	}
	w = doRequest(t, f.handler, http.MethodGet, "/storage/members?ids="+itoa(f.member)+","+itoa(f.owner), f.token, nil)
	var members struct {
		Members []service.MemberStorage `json:"members"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &members) != nil || len(members.Members) != 1 ||
		members.Members[0].QuotaMB == nil || *members.Members[0].QuotaMB != 5 {
		t.Fatalf("members = %d %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, f.handler, http.MethodPatch, "/users/999999/upload-limit", f.token, map[string]any{"quota_mb": 5}); w.Code != http.StatusNotFound {
		t.Errorf("unknown user = %d, want 404", w.Code)
	}
	if w := doRequest(t, f.handler, http.MethodPatch, "/users/"+itoa(f.member)+"/upload-limit", f.token, map[string]any{"quota_mb": -1}); w.Code != http.StatusBadRequest {
		t.Errorf("negative limit = %d, want 400", w.Code)
	}

	stray := filepath.Join(f.dir, "stray")
	if err := os.WriteFile(stray, []byte("leftover"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	for _, p := range []string{stray, filepath.Join(f.dir, "big"), filepath.Join(f.dir, "small")} {
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	w = doRequest(t, f.handler, http.MethodGet, "/storage/leftovers", f.token, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"count":1`) || !strings.Contains(w.Body.String(), `"bytes":8`) {
		t.Fatalf("leftovers = %d %s", w.Code, w.Body.String())
	}
	w = doRequest(t, f.handler, http.MethodPost, "/storage/leftovers", f.token, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"removed":1`) || !strings.Contains(w.Body.String(), `"count":0`) {
		t.Fatalf("cleanup = %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Errorf("stray file still on disk: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "big")); err != nil {
		t.Errorf("a named file was removed: %v", err)
	}
}
