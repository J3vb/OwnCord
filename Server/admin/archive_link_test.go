package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// issueArchiveLink asks for a single-use download link and returns its token
// and the full path the browser would open.
func issueArchiveLink(t *testing.T, f archiveFixture, token string) (string, string) {
	t.Helper()
	w := doRequest(t, f.handler, http.MethodPost, "/archive/link", token, map[string]any{})
	if w.Code != http.StatusOK {
		t.Fatalf("POST /archive/link = %d, want 200; body: %s", w.Code, w.Body.String())
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
	return u.Query().Get("token"), resp.Path
}

// getRawLink opens a download link with no Authorization header, the way a
// browser <a href> would. The browser path carries the /admin/api mount
// prefix; the handler under test serves it relative to that mount.
func getRawLink(t *testing.T, f archiveFixture, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, strings.TrimPrefix(path, "/admin/api"), nil)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	return w
}

// TestArchiveLink_WorksOnceWithoutAuth is the streamed download contract: the
// panel asks for a one-time link with its normal auth, and the browser then
// opens that link with no Authorization header — so the archive is never
// buffered through fetch() in the page.
func TestArchiveLink_WorksOnceWithoutAuth(t *testing.T) {
	f := newArchiveFixture(t)
	_, path := issueArchiveLink(t, f, f.token)

	w := getRawLink(t, f, path)
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200; body: %s", path, w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type = %q, want application/zip", ct)
	}
	if !bytes.HasPrefix(w.Body.Bytes(), []byte("PK")) {
		t.Error("the download is not a zip")
	}

	// Reuse must fail: the link is single-use.
	if again := getRawLink(t, f, path); again.Code == http.StatusOK {
		t.Errorf("reused archive link = %d, want a refusal", again.Code)
	}
}

// TestArchiveLink_NonOwnerCannotIssue: the link grants the archive, which holds
// password hashes and key files, so only the Owner may ask for one.
func TestArchiveLink_NonOwnerCannotIssue(t *testing.T) {
	f := newArchiveFixture(t)
	_, modToken := createRoleUser(t, f.database, 22, "Moderator", permissions.KickMembers, 40, "archivelinkmod")
	if w := doRequest(t, f.handler, http.MethodPost, "/archive/link", modToken, map[string]any{}); w.Code != http.StatusForbidden {
		t.Errorf("moderator POST /archive/link = %d, want 403; body: %s", w.Code, w.Body.String())
	}
}

// TestArchiveLink_WrongRoute: the token is for the archive only. A live token
// is refused where the panel does accept a query-string credential (the log
// stream's ticket) and as a Bearer credential on the archive route itself, and
// is still redeemable afterwards, so the refusals were not a spent token.
func TestArchiveLink_WrongRoute(t *testing.T) {
	f := newArchiveFixture(t)
	token, path := issueArchiveLink(t, f, f.token)

	logs := admin.NewAdminAPI(f.database, "1.0.0", &mockHub{}, nil, admin.NewRingBuffer(8), nil, nil, newTestServices(f.database))
	req := httptest.NewRequest(http.MethodGet, "/logs/stream?ticket="+token, nil)
	w := httptest.NewRecorder()
	logs.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("archive link token as a log-stream ticket = %d, want 401", w.Code)
	}

	if w := doRequest(t, f.handler, http.MethodGet, "/archive", token, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("archive link token as a Bearer credential = %d, want 401", w.Code)
	}

	if w := getRawLink(t, f, path); w.Code != http.StatusOK {
		t.Errorf("GET %s after the refusals = %d, want 200; body: %s", path, w.Code, w.Body.String())
	}
}

// TestArchiveLink_RevokedPrincipal: the link is bound to the credential that
// asked for it, so revoking that session or banning its owner before the link
// is opened voids it.
func TestArchiveLink_RevokedPrincipal(t *testing.T) {
	f := newArchiveFixture(t)
	ctx := context.Background()

	_, path := issueArchiveLink(t, f, f.token)
	if err := f.database.DeleteSession(ctx, auth.HashToken(f.token)); err != nil {
		t.Fatal(err)
	}
	if w := getRawLink(t, f, path); w.Code != http.StatusForbidden {
		t.Errorf("link after its session was revoked = %d, want 403", w.Code)
	}

	g := newArchiveFixture(t)
	_, path = issueArchiveLink(t, g, g.token)
	sess, err := g.database.GetSessionByTokenHash(ctx, auth.HashToken(g.token))
	if err != nil || sess == nil {
		t.Fatalf("GetSessionByTokenHash: %v", err)
	}
	if err := g.database.BanUser(ctx, sess.UserID, "test", nil); err != nil {
		t.Fatal(err)
	}
	if w := getRawLink(t, g, path); w.Code != http.StatusForbidden {
		t.Errorf("link after its owner was banned = %d, want 403", w.Code)
	}
}

// TestArchiveLink_OneBuildAtATime: two builds would each pass the free-space
// check before the other wrote anything, so while one archive is being built
// a second archive request and a new link are both refused with 409.
func TestArchiveLink_OneBuildAtATime(t *testing.T) {
	f := newArchiveFixture(t)
	_, path := issueArchiveLink(t, f, f.token)

	entered := make(chan struct{})
	release := make(chan struct{})
	restore := admin.SetArchiveBeforeSnapshotHook(func() {
		close(entered)
		<-release
	})
	defer restore()

	done := make(chan int)
	go func() { done <- getRawLink(t, f, path).Code }()
	<-entered

	if w := doRequest(t, f.handler, http.MethodGet, "/archive", f.token, nil); w.Code != http.StatusConflict {
		t.Errorf("GET /archive during a build = %d, want 409", w.Code)
	}
	if w := doRequest(t, f.handler, http.MethodPost, "/archive/link", f.token, map[string]any{}); w.Code != http.StatusConflict {
		t.Errorf("POST /archive/link during a build = %d, want 409", w.Code)
	}

	close(release)
	if code := <-done; code != http.StatusOK {
		t.Errorf("the first build = %d, want 200", code)
	}
	restore()
	if w := doRequest(t, f.handler, http.MethodGet, "/archive", f.token, nil); w.Code != http.StatusOK {
		t.Errorf("GET /archive after the build finished = %d, want 200", w.Code)
	}
}

// TestArchiveLink_Expires is the TTL contract: a link older than its short
// window is refused.
func TestArchiveLink_Expires(t *testing.T) {
	defer admin.SetArchiveLinkTTL(1 * time.Millisecond)()
	f := newArchiveFixture(t)
	_, path := issueArchiveLink(t, f, f.token)
	time.Sleep(5 * time.Millisecond)

	if w := getRawLink(t, f, path); w.Code != http.StatusForbidden {
		t.Errorf("expired archive link = %d, want 403", w.Code)
	}
}

// TestArchiveLink_UnknownToken: a token the server never issued is refused.
func TestArchiveLink_UnknownToken(t *testing.T) {
	f := newArchiveFixture(t)
	if w := getRawLink(t, f, "/admin/api/archive/download?token=deadbeef"); w.Code != http.StatusForbidden {
		t.Errorf("unknown archive token = %d, want 403", w.Code)
	}
}
