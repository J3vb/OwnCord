package admin_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
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
		Token string `json:"token"`
		Path  string `json:"path"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Token == "" || resp.Path == "" {
		t.Fatalf("link response missing token/path: %s", w.Body.String())
	}
	return resp.Token, resp.Path
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

// TestArchiveLink_WrongRoute: the token is for the archive only and must not
// authorise any other admin route.
func TestArchiveLink_WrongRoute(t *testing.T) {
	f := newArchiveFixture(t)
	token, _ := issueArchiveLink(t, f, f.token)

	// The same token used as a query param on a different route must not work.
	req := httptest.NewRequest(http.MethodGet, "/stats?ticket="+token, nil)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	if w.Code == http.StatusOK {
		t.Errorf("archive link token authorised GET /stats = %d", w.Code)
	}
}

// TestArchiveLink_Expires is the TTL contract: a link older than its short
// window is refused.
func TestArchiveLink_Expires(t *testing.T) {
	admin.SetArchiveLinkTTLForTest(1 * time.Millisecond)
	defer admin.SetArchiveLinkTTLForTest(0) // 0 = production default
	f := newArchiveFixture(t)
	token, _ := issueArchiveLink(t, f, f.token)
	time.Sleep(5 * time.Millisecond)

	req := httptest.NewRequest(http.MethodGet, "/archive/download?token="+token, nil)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	if w.Code == http.StatusOK {
		t.Errorf("expired archive link = %d, want a refusal", w.Code)
	}
}

// TestArchiveLink_UnknownToken: a token the server never issued is refused.
func TestArchiveLink_UnknownToken(t *testing.T) {
	f := newArchiveFixture(t)
	req := httptest.NewRequest(http.MethodGet, "/archive/download?token=deadbeef", nil)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, req)
	if w.Code == http.StatusOK {
		t.Errorf("unknown archive token = %d, want a refusal", w.Code)
	}
}
