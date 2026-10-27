package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// linkFixture is a file in channel 1 that both a viewer and its uploader can
// read, behind the real upload routes.
type linkFixture struct {
	database *db.DB
	router   http.Handler
	perms    *service.PermissionService
	fileID   string
	owner    string // uploader's bearer token
	viewer   string // second member's bearer token
	content  []byte
}

func newLinkFixture(t *testing.T) linkFixture {
	t.Helper()
	database := newUploadTestDB(t)
	perms := service.NewPermissionService(database, permissions.NewChecker(database))
	r := chi.NewRouter()
	api.MountUploadRoutes(r, service.NewSessionService(database), newUploadTestStorage(t), auth.NewRateLimiter(), nil, service.NewUploadService(database, perms))
	var router http.Handler = r
	owner := uploadCreateToken(t, database, "linkowner", 4)
	viewer := uploadCreateToken(t, database, "linkviewer", 4)
	content := []byte(strings.Repeat("0123456789", 100))
	rr := doUpload(t, router, owner, "file", "clip.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode upload: %v", err)
	}
	fileID, _ := resp["id"].(string)
	ctx := context.Background()
	for _, q := range []string{
		`INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`,
		`INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, 1, 'hi')`,
	} {
		if _, err := database.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if _, err := database.ExecContext(ctx, `UPDATE attachments SET message_id = 1 WHERE id = ?`, fileID); err != nil {
		t.Fatalf("link attachment: %v", err)
	}
	return linkFixture{database: database, router: router, perms: perms, fileID: fileID, owner: owner, viewer: viewer, content: content}
}

func (f linkFixture) mint(t *testing.T, fileID, token string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/files/"+fileID+"/link", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	f.router.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		return rr.Code, ""
	}
	var body struct {
		Path      string `json:"path"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("decode link: %v", err)
	}
	if _, err := time.Parse(time.RFC3339, body.ExpiresAt); err != nil {
		t.Errorf("expires_at %q is not RFC 3339: %v", body.ExpiresAt, err)
	}
	return rr.Code, body.Path
}

func (f linkFixture) get(path string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rr := httptest.NewRecorder()
	f.router.ServeHTTP(rr, req)
	return rr
}

func TestFileLink_IssueNeedsAccessToTheFile(t *testing.T) {
	f := newLinkFixture(t)
	if code, path := f.mint(t, f.fileID, f.viewer); code != http.StatusOK || !strings.HasPrefix(path, "/api/v1/files/"+f.fileID+"?link=") {
		t.Fatalf("viewer mint = %d %q, want 200 and a file path", code, path)
	}
	if code, _ := f.mint(t, f.fileID, ""); code != http.StatusUnauthorized {
		t.Errorf("unauthenticated mint = %d, want 401", code)
	}
	if code, _ := f.mint(t, "no-such-file", f.viewer); code != http.StatusNotFound {
		t.Errorf("unknown file mint = %d, want 404", code)
	}
	if _, err := f.database.ExecContext(context.Background(), `INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (1, 4, 0, 2)`); err != nil {
		t.Fatalf("override: %v", err)
	}
	f.perms.InvalidateAll()
	if code, _ := f.mint(t, f.fileID, f.viewer); code != http.StatusForbidden {
		t.Errorf("mint without channel access = %d, want 403", code)
	}
}

func TestFileLink_RedeemServesFileAndRange(t *testing.T) {
	f := newLinkFixture(t)
	_, path := f.mint(t, f.fileID, f.viewer)

	rr := f.get(path, nil)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), f.content) {
		t.Fatalf("link GET = %d (%d bytes), want 200 with the file", rr.Code, rr.Body.Len())
	}
	// A player makes many Range requests: the link must keep working.
	for i := range 3 {
		rr = f.get(path, map[string]string{"Range": "bytes=10-19"})
		if rr.Code != http.StatusPartialContent {
			t.Fatalf("range %d = %d, want 206", i, rr.Code)
		}
		if got, want := rr.Body.String(), string(f.content[10:20]); got != want {
			t.Errorf("range body = %q, want %q", got, want)
		}
	}
	if cc := rr.Header().Get("Cache-Control"); !strings.Contains(cc, "private") {
		t.Errorf("Cache-Control = %q, want private", cc)
	}
}

func TestFileLink_SameCredentialSameFileReusesToken(t *testing.T) {
	f := newLinkFixture(t)
	_, a := f.mint(t, f.fileID, f.viewer)
	_, b := f.mint(t, f.fileID, f.viewer)
	if a != b {
		t.Errorf("a second mint returned a different link; the map grows with every re-render")
	}
	_, c := f.mint(t, f.fileID, f.owner)
	if a == c {
		t.Errorf("two credentials share one link")
	}
}

func TestFileLink_WrongFileIDIsRefused(t *testing.T) {
	f := newLinkFixture(t)
	rr := doUpload(t, f.router, f.viewer, "file", "other.txt", []byte("other file"))
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	otherID, _ := resp["id"].(string)
	if otherID == "" {
		t.Fatal("second upload returned no id")
	}
	_, path := f.mint(t, f.fileID, f.viewer)
	_, query, _ := strings.Cut(path, "?")
	token := query
	// The viewer owns the other (unlinked) file, so only the binding stops this.
	if rr := f.get("/api/v1/files/"+otherID+"?"+token, nil); rr.Code != http.StatusForbidden {
		t.Errorf("link replayed on another file = %d, want 403", rr.Code)
	}
}

func TestFileLink_ExpiredLinkIsRefused(t *testing.T) {
	restore := api.SetFileLinkTTLForTest(40 * time.Millisecond)
	defer restore()
	f := newLinkFixture(t)
	_, path := f.mint(t, f.fileID, f.viewer)
	if rr := f.get(path, nil); rr.Code != http.StatusOK {
		t.Fatalf("fresh link = %d, want 200", rr.Code)
	}
	time.Sleep(80 * time.Millisecond)
	if rr := f.get(path, nil); rr.Code != http.StatusForbidden {
		t.Errorf("expired link = %d, want 403", rr.Code)
	}
}

// Edge case 1: the session is gone while the clip streams. The very next
// Range request is a 403, and so is a re-mint with the dead credential.
func TestFileLink_SignedOutOrExpiredSessionVoidsLink(t *testing.T) {
	for name, kill := range map[string]string{
		"signed out":      `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'linkviewer')`,
		"session expired": `UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = (SELECT id FROM users WHERE username = 'linkviewer')`,
		"banned":          `UPDATE users SET banned = 1 WHERE username = 'linkviewer'`,
	} {
		t.Run(name, func(t *testing.T) {
			f := newLinkFixture(t)
			_, path := f.mint(t, f.fileID, f.viewer)
			if rr := f.get(path, map[string]string{"Range": "bytes=0-9"}); rr.Code != http.StatusPartialContent {
				t.Fatalf("before = %d, want 206", rr.Code)
			}
			if _, err := f.database.ExecContext(context.Background(), kill); err != nil {
				t.Fatalf("kill: %v", err)
			}
			rr := f.get(path, map[string]string{"Range": "bytes=10-19"})
			if rr.Code != http.StatusForbidden {
				t.Errorf("after = %d, want 403", rr.Code)
			}
			if bytes.Contains(rr.Body.Bytes(), f.content[:10]) {
				t.Errorf("a refused link leaked file bytes")
			}
			if code, _ := f.mint(t, f.fileID, f.viewer); code == http.StatusOK {
				t.Errorf("re-mint with the dead credential succeeded")
			}
		})
	}
}

// Edge case 2: the user loses channel access after the link was minted.
func TestFileLink_LostChannelAccessIsRefused(t *testing.T) {
	f := newLinkFixture(t)
	_, path := f.mint(t, f.fileID, f.viewer)
	if _, err := f.database.ExecContext(context.Background(), `INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (1, 4, 0, 2)`); err != nil {
		t.Fatalf("override: %v", err)
	}
	f.perms.InvalidateAll()
	if rr := f.get(path, nil); rr.Code != http.StatusForbidden {
		t.Errorf("link after losing the channel = %d, want 403", rr.Code)
	}
}

func TestFileLink_UnknownTokenAndAbsentCredentialAreTheSame403(t *testing.T) {
	f := newLinkFixture(t)
	bogus := f.get("/api/v1/files/"+f.fileID+"?link="+strings.Repeat("a", 64), nil)
	_, path := f.mint(t, f.fileID, f.viewer)
	if _, err := f.database.ExecContext(context.Background(), `DELETE FROM sessions`); err != nil {
		t.Fatal(err)
	}
	dead := f.get(path, nil)
	if bogus.Code != http.StatusForbidden || dead.Code != http.StatusForbidden {
		t.Fatalf("bogus=%d dead=%d, want both 403", bogus.Code, dead.Code)
	}
	if bogus.Body.String() != dead.Body.String() {
		t.Errorf("refusals differ: %q vs %q", bogus.Body.String(), dead.Body.String())
	}
	// No link and no header is still the bearer perimeter's 401.
	if rr := f.get("/api/v1/files/"+f.fileID, nil); rr.Code != http.StatusUnauthorized {
		t.Errorf("no credentials = %d, want 401", rr.Code)
	}
}

func TestFileLink_AuthorizationHeaderTakesPrecedence(t *testing.T) {
	f := newLinkFixture(t)
	_, path := f.mint(t, f.fileID, f.viewer)
	// A valid link plus a bad bearer: the header wins, so this is a 401.
	if rr := f.get(path, map[string]string{"Authorization": "Bearer nope"}); rr.Code != http.StatusUnauthorized {
		t.Errorf("link + bad bearer = %d, want 401 (link ignored)", rr.Code)
	}
	// A bogus link plus a good bearer: the link is ignored, so this is a 200.
	rr := f.get("/api/v1/files/"+f.fileID+"?link=bogus", map[string]string{"Authorization": "Bearer " + f.viewer})
	if rr.Code != http.StatusOK {
		t.Errorf("bogus link + good bearer = %d, want 200", rr.Code)
	}
}

func TestFileLink_ThumbRouteDoesNotAcceptLinks(t *testing.T) {
	f := newLinkFixture(t)
	_, path := f.mint(t, f.fileID, f.viewer)
	_, query, _ := strings.Cut(path, "?")
	token := query
	if rr := f.get("/api/v1/files/"+f.fileID+"/thumb?"+token, nil); rr.Code != http.StatusUnauthorized {
		t.Errorf("thumb with a link = %d, want 401", rr.Code)
	}
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func TestFileLink_TokenIsNeverLogged(t *testing.T) {
	var buf lockedBuf
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)

	f := newLinkFixture(t)
	_, path := f.mint(t, f.fileID, f.viewer)
	_, token, _ := strings.Cut(path, "link=")
	f.get(path, nil)
	if _, err := f.database.ExecContext(context.Background(), `DELETE FROM sessions`); err != nil {
		t.Fatal(err)
	}
	f.get(path, nil)
	if strings.Contains(buf.String(), token) {
		t.Errorf("the link token appears in the log output")
	}
}

func TestFileLinks_CapAndSweep(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := api.NewFileLinksForTest(func() time.Time { return now })

	// Fill to the cap, one tick apart so "soonest to expire" is well defined.
	first, _, err := l.Issue("f0", "h0")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < api.FileLinkMaxEntriesForTest; i++ {
		now = now.Add(time.Millisecond)
		if _, _, err := l.Issue("f", fmt.Sprintf("h%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if got := l.Size(); got != api.FileLinkMaxEntriesForTest {
		t.Fatalf("size = %d, want %d", got, api.FileLinkMaxEntriesForTest)
	}
	// One more past the cap evicts the soonest-expiring link, not the newest.
	now = now.Add(time.Millisecond)
	newest, _, _ := l.Issue("fnew", "hnew")
	if got := l.Size(); got != api.FileLinkMaxEntriesForTest {
		t.Errorf("size past the cap = %d, want it held at %d", got, api.FileLinkMaxEntriesForTest)
	}
	if _, ok := l.Lookup(first, "f0"); ok {
		t.Errorf("the oldest link survived eviction")
	}
	if _, ok := l.Lookup(newest, "fnew"); !ok {
		t.Errorf("the newest link was evicted")
	}
	// Everything expires, and the next issue sweeps the lot.
	now = now.Add(2 * time.Hour)
	if _, _, err := l.Issue("fx", "hx"); err != nil {
		t.Fatal(err)
	}
	if got := l.Size(); got != 1 {
		t.Errorf("size after the sweep = %d, want 1", got)
	}
}

// A replaced link is left to expire: a player holding the old one keeps working.
func TestFileLinks_ReissueKeepsTheOldTokenRedeemable(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := api.NewFileLinksForTest(func() time.Time { return now })
	old, _, err := l.Issue("f", "h")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(55 * time.Minute) // under the reuse margin
	fresh, _, err := l.Issue("f", "h")
	if err != nil {
		t.Fatal(err)
	}
	if fresh == old {
		t.Fatal("a link near expiry was handed out again")
	}
	if _, ok := l.Lookup(old, "f"); !ok {
		t.Errorf("the replaced link stopped working before it expired")
	}
	if _, ok := l.Lookup(fresh, "f"); !ok {
		t.Errorf("the new link does not redeem")
	}
	now = now.Add(10 * time.Minute)
	if _, ok := l.Lookup(old, "f"); ok {
		t.Errorf("the replaced link outlived its expiry")
	}
}

func TestFileLinks_PerCredentialCapEvictsItsOwnSoonest(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := api.NewFileLinksForTest(func() time.Time { return now })
	other, _, _ := l.Issue("o", "other")
	first, _, _ := l.Issue("f0", "h")
	for i := 1; i <= api.FileLinkMaxPerCredentialForTest; i++ {
		now = now.Add(time.Second)
		if _, _, err := l.Issue(fmt.Sprintf("f%d", i), "h"); err != nil {
			t.Fatal(err)
		}
	}
	if got, want := l.Size(), api.FileLinkMaxPerCredentialForTest+1; got != want {
		t.Errorf("size = %d, want %d (cap for h plus the other credential)", got, want)
	}
	if _, ok := l.Lookup(first, "f0"); ok {
		t.Errorf("the credential's soonest link survived the cap")
	}
	if _, ok := l.Lookup(other, "o"); !ok {
		t.Errorf("another credential's link was evicted")
	}
}

func TestFileLink_IssueIsRateLimitedPerUser(t *testing.T) {
	database := newUploadTestDB(t)
	limiter := auth.NewRateLimiter()
	perms := service.NewPermissionService(database, permissions.NewChecker(database))
	r := chi.NewRouter()
	api.MountUploadRoutes(r, service.NewSessionService(database), newUploadTestStorage(t), limiter, nil, service.NewUploadService(database, perms))
	owner := uploadCreateToken(t, database, "ratelinkowner", 4)
	rr := doUpload(t, r, owner, "file", "a.txt", []byte("abc"))
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID, _ := resp["id"].(string)
	var uid int64
	if err := database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'ratelinkowner'`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	post := func() int {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/files/"+fileID+"/link", nil)
		req.Header.Set("Authorization", "Bearer "+owner)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code
	}
	if code := post(); code != http.StatusOK {
		t.Fatalf("first mint = %d, want 200", code)
	}
	for range api.FileLinkRateLimitPerMinuteForTest {
		limiter.Allow(auth.Key("file_link", uid), api.FileLinkRateLimitPerMinuteForTest, time.Minute)
	}
	if code := post(); code != http.StatusTooManyRequests {
		t.Errorf("mint past the limit = %d, want 429", code)
	}
}
