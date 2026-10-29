package admin_test

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// backupLinkFixture is an admin API with two backup files on disk and an
// Owner session.
type backupLinkFixture struct {
	handler http.Handler
	token   string
	dir     string
}

func newBackupLinkFixture(t *testing.T) backupLinkFixture {
	t.Helper()
	dir := filepath.Join(chdirTemp(t), "data", "backups")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"chatserver_20260901_100000.db": "first backup bytes",
		"chatserver_20260902_100000.db": "second backup bytes",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	return backupLinkFixture{handler: handler, token: createAdminUser(t, database), dir: dir}
}

// issueBackupLink asks for a single-use link to one backup and returns the
// path the browser would open.
func issueBackupLink(t *testing.T, f backupLinkFixture, name string) string {
	t.Helper()
	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+name+"/link", f.token, map[string]any{})
	if w.Code != http.StatusOK {
		t.Fatalf("POST /backups/%s/link = %d, want 200; body: %s", name, w.Code, w.Body.String())
	}
	var resp struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	u, err := url.Parse(resp.Path)
	if err != nil || u.Query().Get("token") == "" {
		t.Fatalf("link response has no token in its path: %s", w.Body.String())
	}
	return resp.Path
}

// openBackupLink opens a link the way a browser <a href> does: no
// Authorization header.
func openBackupLink(t *testing.T, f backupLinkFixture, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, strings.TrimPrefix(path, "/admin/api"), nil)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	return w
}

// TestBackupLink_WorksOnce: the owner asks for a link with normal auth, the
// browser opens it without any, it serves that one backup file, and it cannot
// be opened a second time.
func TestBackupLink_WorksOnce(t *testing.T) {
	f := newBackupLinkFixture(t)
	path := issueBackupLink(t, f, "chatserver_20260901_100000.db")

	w := openBackupLink(t, f, path)
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200; body: %s", path, w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != "first backup bytes" {
		t.Errorf("body = %q, want the backup file's bytes", got)
	}
	cd := w.Header().Get("Content-Disposition")
	if disp, params, err := mime.ParseMediaType(cd); err != nil || disp != "attachment" || params["filename"] != "chatserver_20260901_100000.db" {
		t.Errorf("Content-Disposition = %q, want an attachment named after the backup", cd)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}

	if again := openBackupLink(t, f, path); again.Code != http.StatusForbidden {
		t.Errorf("reused backup link = %d, want 403", again.Code)
	}
}

// TestBackupLink_BoundToOneFile: a token issued for one backup does not open
// another, and trying spends it.
func TestBackupLink_BoundToOneFile(t *testing.T) {
	f := newBackupLinkFixture(t)
	path := issueBackupLink(t, f, "chatserver_20260901_100000.db")
	other := strings.Replace(path, "chatserver_20260901_100000.db", "chatserver_20260902_100000.db", 1)

	if w := openBackupLink(t, f, other); w.Code != http.StatusForbidden {
		t.Errorf("token used for a different backup = %d, want 403", w.Code)
	}
	if w := openBackupLink(t, f, path); w.Code != http.StatusForbidden {
		t.Errorf("token after a refused redemption = %d, want 403 (single-use)", w.Code)
	}
}

// TestBackupLink_NonOwnerRefused: backups hold every account's password hash,
// so a link is for the owner or a MANAGE_BACKUPS holder (WP 8.4c). A role with
// the server and role powers but not that bit is refused; an Administrator
// passes like for every bit (TestManageBackups_HolderCanCreateListAndDownload).
func TestBackupLink_NonOwnerRefused(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, adminToken := createRoleUser(t, database, 2, "Admin", permissions.AllPerms&^permissions.Administrator&^permissions.ManageBackups, 80, "backuplinkadmin")

	w := doRequest(t, handler, http.MethodPost, "/backups/chatserver_20260901_100000.db/link", adminToken, map[string]any{})
	if w.Code != http.StatusForbidden {
		t.Errorf("non-owner without MANAGE_BACKUPS POST backup link = %d, want 403; body: %s", w.Code, w.Body.String())
	}
}

// TestBackupLink_Expires: a link older than its short window is refused.
func TestBackupLink_Expires(t *testing.T) {
	defer admin.SetArchiveLinkTTL(1 * time.Millisecond)()
	f := newBackupLinkFixture(t)
	path := issueBackupLink(t, f, "chatserver_20260901_100000.db")
	time.Sleep(5 * time.Millisecond)

	if w := openBackupLink(t, f, path); w.Code != http.StatusForbidden {
		t.Errorf("expired backup link = %d, want 403", w.Code)
	}
}

// TestBackupLink_RevokedSession: the link is bound to the credential that
// asked for it, so signing that session out before opening it voids it.
func TestBackupLink_RevokedSession(t *testing.T) {
	chdir := chdirTemp(t)
	dir := filepath.Join(chdir, "data", "backups")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.db"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	database := openAdminTestDB(t)
	f := backupLinkFixture{
		handler: admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database)),
		token:   createAdminUser(t, database),
		dir:     dir,
	}
	path := issueBackupLink(t, f, "b.db")
	if err := database.DeleteSession(context.Background(), auth.HashToken(f.token)); err != nil {
		t.Fatal(err)
	}
	if w := openBackupLink(t, f, path); w.Code != http.StatusForbidden {
		t.Errorf("link after its session was revoked = %d, want 403", w.Code)
	}
}

// TestBackupLink_UnknownOrMissing: an unknown token is refused, and no link
// is issued for a backup that does not exist or a name that escapes the
// backup directory.
func TestBackupLink_UnknownOrMissing(t *testing.T) {
	f := newBackupLinkFixture(t)
	if w := openBackupLink(t, f, "/admin/api/backups/chatserver_20260901_100000.db/download?token=deadbeef"); w.Code != http.StatusForbidden {
		t.Errorf("unknown token = %d, want 403", w.Code)
	}
	if w := openBackupLink(t, f, "/admin/api/backups/chatserver_20260901_100000.db/download"); w.Code != http.StatusForbidden {
		t.Errorf("no token = %d, want 403", w.Code)
	}
	if w := doRequest(t, f.handler, http.MethodPost, "/backups/nope.db/link", f.token, map[string]any{}); w.Code != http.StatusNotFound {
		t.Errorf("link for a missing backup = %d, want 404", w.Code)
	}
	if w := doRequest(t, f.handler, http.MethodPost, "/backups/..%2Fchatserver.db/link", f.token, map[string]any{}); w.Code != http.StatusBadRequest {
		t.Errorf("link for a traversal name = %d, want 400", w.Code)
	}
}

// TestBackupLink_NotAnArchiveToken: a backup link token opens neither the
// full archive nor works as a Bearer credential.
func TestBackupLink_NotAnArchiveToken(t *testing.T) {
	f := newBackupLinkFixture(t)
	path := issueBackupLink(t, f, "chatserver_20260901_100000.db")
	u, _ := url.Parse(path)
	token := u.Query().Get("token")

	if w := openBackupLink(t, f, "/admin/api/archive/download?token="+token); w.Code != http.StatusForbidden {
		t.Errorf("backup token on the archive route = %d, want 403", w.Code)
	}
	if w := doRequest(t, f.handler, http.MethodGet, "/backups", token, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("backup token as a Bearer credential = %d, want 401", w.Code)
	}
	if w := openBackupLink(t, f, path); w.Code != http.StatusOK {
		t.Errorf("GET %s after the refusals = %d, want 200; body: %s", path, w.Code, w.Body.String())
	}
}

// TestBackupLink_SlowDownloadOutlivesWriteTimeout: the HTTP server carrying
// /admin has a fixed WriteTimeout (30 s in production, 300 ms here) that net/http
// arms once per request. A download that keeps making progress must not be
// cut by it, even when the whole transfer takes several times longer.
func TestBackupLink_SlowDownloadOutlivesWriteTimeout(t *testing.T) {
	f := newBackupLinkFixture(t)
	const name = "chatserver_20260903_100000.db"
	body := make([]byte, 32<<20) // far more than the socket buffers can hold
	if err := os.WriteFile(filepath.Join(f.dir, name), body, 0o600); err != nil {
		t.Fatal(err)
	}
	path := issueBackupLink(t, f, name)

	srv := httptest.NewUnstartedServer(http.StripPrefix("/admin/api", f.handler))
	srv.Config.WriteTimeout = 300 * time.Millisecond
	srv.Start()
	t.Cleanup(srv.Close)

	// A small receive buffer, so the server blocks on the connection rather
	// than finishing into kernel buffers before the timeout can matter.
	dialer := &net.Dialer{}
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := dialer.DialContext(ctx, network, addr)
			if tcp, ok := c.(*net.TCPConn); ok {
				_ = tcp.SetReadBuffer(64 << 10)
			}
			return c, err
		},
	}}
	t.Cleanup(client.CloseIdleConnections)

	res, err := client.Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close() //nolint:errcheck
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	// Three pauses, each longer than the whole WriteTimeout, with the
	// transfer moving in between.
	got := 0
	buf := make([]byte, 4<<20)
	for range 3 {
		time.Sleep(400 * time.Millisecond)
		n, err := io.ReadFull(res.Body, buf)
		got += n
		if err != nil {
			t.Fatalf("download cut after %d of %d bytes: %v", got, len(body), err)
		}
	}
	rest, err := io.Copy(io.Discard, res.Body)
	if err != nil {
		t.Fatalf("download cut after %d of %d bytes: %v", got+int(rest), len(body), err)
	}
	if total := got + int(rest); total != len(body) {
		t.Fatalf("received %d of %d bytes", total, len(body))
	}
}
