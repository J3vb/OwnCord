package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

// ─── harness ─────────────────────────────────────────────────────────────────

type recordingStickerBroadcaster struct {
	mu    sync.Mutex
	calls [][]*db.Sticker
}

func (b *recordingStickerBroadcaster) BroadcastStickerUpdate(list []*db.Sticker) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, list)
}

func (b *recordingStickerBroadcaster) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.calls)
}

type stickerHarness struct {
	router      http.Handler
	database    *db.DB
	store       *storage.Storage
	dir         string
	broadcaster *recordingStickerBroadcaster
	ownerToken  string // ADMINISTRATOR
	adminToken  string // MANAGE_SERVER, no ADMINISTRATOR
	memberToken string // neither
}

func newStickerHarness(t *testing.T) *stickerHarness {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, execErr := database.ExecContext(context.Background(), q, args...); execErr != nil {
			t.Fatalf("exec %q: %v", q, execErr)
		}
	}
	exec(`UPDATE roles SET permissions = ? WHERE id = ?`, permissions.Administrator, permissions.OwnerRoleID)
	exec(`UPDATE roles SET permissions = ? WHERE id = ?`,
		permissions.ManageServer|permissions.ReadMessages|permissions.SendMessages, permissions.AdminRoleID)
	exec(`UPDATE roles SET permissions = ? WHERE id = ?`,
		permissions.ReadMessages|permissions.SendMessages|permissions.AddReactions, permissions.MemberRoleID)

	dir := t.TempDir()
	store, err := storage.New(dir, 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	h := &stickerHarness{database: database, store: store, dir: dir, broadcaster: &recordingStickerBroadcaster{}}
	svc := service.New(database, auth.NewRateLimiter())
	r := chi.NewRouter()
	api.MountStickerRoutes(r, svc, store, auth.NewRateLimiter(), h.broadcaster)
	h.router = r

	h.ownerToken = emojiSeedUser(t, database, "owner", int(permissions.OwnerRoleID))
	h.adminToken = emojiSeedUser(t, database, "admin", int(permissions.AdminRoleID))
	h.memberToken = emojiSeedUser(t, database, "member", int(permissions.MemberRoleID))
	return h
}

func (h *stickerHarness) do(t *testing.T, method, path, token string, body *bytes.Buffer, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, body)
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

// upload POSTs a multipart sticker. An empty name or emoji omits the field, a
// nil content omits the file.
func (h *stickerHarness) upload(t *testing.T, token, name, emoji string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	if name != "" {
		_ = w.WriteField("name", name)
	}
	if emoji != "" {
		_ = w.WriteField("emoji", emoji)
	}
	if content != nil {
		part, err := w.CreateFormFile("file", "sticker.bin")
		if err != nil {
			t.Fatalf("CreateFormFile: %v", err)
		}
		_, _ = part.Write(content)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return h.do(t, http.MethodPost, "/api/v1/stickers", token, body, w.FormDataContentType())
}

func (h *stickerHarness) patch(t *testing.T, token string, id int64, body string) *httptest.ResponseRecorder {
	t.Helper()
	return h.do(t, http.MethodPatch, fmt.Sprintf("/api/v1/stickers/%d", id), token, bytes.NewBufferString(body), "application/json")
}

func (h *stickerHarness) storedFiles(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		t.Fatalf("read store dir: %v", err)
	}
	return len(entries)
}

type stickerJSON struct {
	ID    int64   `json:"id"`
	Name  string  `json:"name"`
	Emoji *string `json:"emoji"`
	URL   string  `json:"url"`
}

func decodeSticker(t *testing.T, rec *httptest.ResponseRecorder) stickerJSON {
	t.Helper()
	var s stickerJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatalf("unmarshal %q: %v", rec.Body.String(), err)
	}
	return s
}

// ─── GET ─────────────────────────────────────────────────────────────────────

func TestStickerList_RequiresAuth(t *testing.T) {
	h := newStickerHarness(t)
	if rec := h.do(t, http.MethodGet, "/api/v1/stickers", "", nil, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestStickerList_EmptyIsJSONArray(t *testing.T) {
	h := newStickerHarness(t)
	rec := h.do(t, http.MethodGet, "/api/v1/stickers", h.memberToken, nil, "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("status = %d body = %q, want 200 []", rec.Code, rec.Body.String())
	}
}

func TestStickerList_AnyMemberSeesIdNameEmojiUrl(t *testing.T) {
	h := newStickerHarness(t)
	if rec := h.upload(t, h.ownerToken, "Wave", "👋", pngBytes(t, 64, 64)); rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d (%s)", rec.Code, rec.Body.String())
	}
	if rec := h.upload(t, h.ownerToken, "alpha", "", pngBytes(t, 64, 64)); rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d (%s)", rec.Code, rec.Body.String())
	}
	rec := h.do(t, http.MethodGet, "/api/v1/stickers", h.memberToken, nil, "")
	var list []stickerJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list) != 2 {
		t.Fatalf("list = %q, %v", rec.Body.String(), err)
	}
	if list[0].Name != "alpha" || list[0].Emoji != nil || list[1].Name != "Wave" || list[1].Emoji == nil || *list[1].Emoji != "👋" {
		t.Errorf("list = %+v, want alpha (no emoji) then Wave (👋), by name", list)
	}
	if want := fmt.Sprintf("/api/v1/stickers/%d/image", list[1].ID); list[1].URL != want {
		t.Errorf("url = %q, want %q", list[1].URL, want)
	}
}

// ─── POST ────────────────────────────────────────────────────────────────────

func TestStickerUpload_PermissionGate(t *testing.T) {
	h := newStickerHarness(t)
	if rec := h.upload(t, h.memberToken, "Wave", "", pngBytes(t, 64, 64)); rec.Code != http.StatusForbidden {
		t.Fatalf("member status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}
	if rec := h.upload(t, "", "Wave", "", pngBytes(t, 64, 64)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status = %d, want 401", rec.Code)
	}
	if h.broadcaster.count() != 0 || h.storedFiles(t) != 0 {
		t.Errorf("a refused upload broadcast or stored something")
	}
	rec := h.upload(t, h.adminToken, "Wave", "", pngBytes(t, 64, 64))
	if rec.Code != http.StatusCreated {
		t.Fatalf("MANAGE_SERVER status = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
	if h.broadcaster.count() != 1 || len(h.broadcaster.calls[0]) != 1 || h.broadcaster.calls[0][0].Name != "Wave" {
		t.Errorf("broadcast calls = %+v, want the one new sticker", h.broadcaster.calls)
	}
}

func TestStickerUpload_AcceptsPNGGIFWebPAndRejectsTheRest(t *testing.T) {
	h := newStickerHarness(t)
	ok := map[string][]byte{
		"apng":  pngBytes(t, 320, 320),
		"agif":  gifBytes(t, 100, 100),
		"awebp": webpVP8LBytes(48, 48),
	}
	for name, content := range ok {
		if rec := h.upload(t, h.ownerToken, name, "", content); rec.Code != http.StatusCreated {
			t.Errorf("%s: status = %d, want 201 (%s)", name, rec.Code, rec.Body.String())
		}
	}
	svg := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><script>alert(1)</script></svg>`)
	bad := map[string][]byte{
		"ajpeg": jpegBytes(t, 64, 32),
		"asvg":  svg,
		"atext": []byte("this is definitely not an image at all"),
	}
	before := h.storedFiles(t)
	for name, content := range bad {
		rec := h.upload(t, h.ownerToken, name, "", content)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "PNG, GIF or WebP") {
			t.Errorf("%s: status = %d body = %q, want 400 naming the formats", name, rec.Code, rec.Body.String())
		}
	}
	if h.storedFiles(t) != before {
		t.Errorf("a refused upload left a file behind")
	}
}

func TestStickerUpload_DimensionAndSizeCaps(t *testing.T) {
	h := newStickerHarness(t)
	for name, content := range map[string][]byte{
		"wide":    pngBytes(t, 321, 64),
		"tall":    pngBytes(t, 64, 321),
		"widewep": webpVP8LBytes(400, 40),
	} {
		rec := h.upload(t, h.ownerToken, name, "", content)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "320x320") {
			t.Errorf("%s: status = %d body = %q, want 400 naming 320x320", name, rec.Code, rec.Body.String())
		}
	}
	big := make([]byte, 600<<10)
	copy(big, pngBytes(t, 128, 128))
	if rec := h.upload(t, h.ownerToken, "huge", "", big); rec.Code != http.StatusBadRequest {
		t.Errorf("oversize file status = %d, want 400", rec.Code)
	}
	if h.storedFiles(t) != 0 {
		t.Errorf("a refused upload left a file behind")
	}
}

func TestStickerUpload_RejectsBadNameEmojiAndMissingFile(t *testing.T) {
	h := newStickerHarness(t)
	img := pngBytes(t, 32, 32)
	for _, name := range []string{"", "a", strings.Repeat("x", 31), "dot.name", "emojié"} {
		if rec := h.upload(t, h.ownerToken, name, "", img); rec.Code != http.StatusBadRequest {
			t.Errorf("name %q: status = %d, want 400", name, rec.Code)
		}
	}
	for _, emoji := range []string{"plain words", strings.Repeat("😀", 20), "😀😀 😀"} {
		if rec := h.upload(t, h.ownerToken, "Okay", emoji, img); rec.Code != http.StatusBadRequest {
			t.Errorf("emoji %q: status = %d, want 400", emoji, rec.Code)
		}
	}
	if rec := h.upload(t, h.ownerToken, "Okay", "", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("missing file: status = %d, want 400", rec.Code)
	}
	if h.storedFiles(t) != 0 {
		t.Errorf("a refused upload left a file behind")
	}
}

func TestStickerUpload_DuplicateNameIsConflictAndLeavesNoOrphan(t *testing.T) {
	h := newStickerHarness(t)
	if rec := h.upload(t, h.ownerToken, "Wave", "", pngBytes(t, 32, 32)); rec.Code != http.StatusCreated {
		t.Fatalf("first upload status = %d", rec.Code)
	}
	if h.storedFiles(t) != 1 {
		t.Fatalf("files after first upload = %d, want 1", h.storedFiles(t))
	}
	for _, name := range []string{"Wave", "WAVE", "wave"} {
		if rec := h.upload(t, h.ownerToken, name, "", pngBytes(t, 32, 32)); rec.Code != http.StatusConflict {
			t.Fatalf("%q: status = %d, want 409 (%s)", name, rec.Code, rec.Body.String())
		}
	}
	if n := h.storedFiles(t); n != 1 {
		t.Fatalf("files after conflicting uploads = %d, want 1 (no orphan)", n)
	}
	if h.broadcaster.count() != 1 {
		t.Errorf("broadcasts = %d, want only the successful one", h.broadcaster.count())
	}
}

// Edge case (b): two admins upload the same name at once. One wins with 201,
// the other gets 409, and no orphan file is left in storage.
func TestStickerUpload_ConcurrentSameNameOneWinsNoOrphan(t *testing.T) {
	h := newStickerHarness(t)
	const racers = 6
	codes := make([]int, racers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range racers {
		wg.Go(func() {
			token := h.ownerToken
			if i%2 == 1 {
				token = h.adminToken
			}
			body := &bytes.Buffer{}
			w := multipart.NewWriter(body)
			_ = w.WriteField("name", "Race")
			part, _ := w.CreateFormFile("file", "s.png")
			_, _ = part.Write(pngBytes(t, 32, 32))
			_ = w.Close()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/stickers", body)
			req.Header.Set("Content-Type", w.FormDataContentType())
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			<-start
			h.router.ServeHTTP(rec, req)
			codes[i] = rec.Code
		})
	}
	close(start)
	wg.Wait()

	created, conflicts := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflicts++
		default:
			t.Errorf("unexpected status %d in %v", c, codes)
		}
	}
	if created != 1 || conflicts != racers-1 {
		t.Fatalf("statuses = %v, want exactly one 201 and the rest 409", codes)
	}
	list, err := h.database.ListStickers(context.Background())
	if err != nil || len(list) != 1 {
		t.Fatalf("ListStickers = %+v, %v; want one row", list, err)
	}
	if n := h.storedFiles(t); n != 1 {
		t.Fatalf("stored files = %d, want 1 (the winner's); losers must not leave orphans", n)
	}
}

func TestStickerUpload_CapIsEnforcedWithoutAnOrphan(t *testing.T) {
	h := newStickerHarness(t)
	for i := range service.MaxStickerCount {
		if _, err := h.database.CreateSticker(context.Background(), fmt.Sprintf("seed-%02d", i), nil, "f", "image/png", 1); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	rec := h.upload(t, h.ownerToken, "One More", "", pngBytes(t, 32, 32))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	if h.storedFiles(t) != 0 {
		t.Errorf("the refused upload left a file behind")
	}
}

// ─── GET image ───────────────────────────────────────────────────────────────

func TestStickerImage_ServesStoredBytesToAnyMember(t *testing.T) {
	h := newStickerHarness(t)
	content := gifBytes(t, 40, 40)
	created := decodeSticker(t, h.upload(t, h.ownerToken, "Wave", "", content))

	got := h.do(t, http.MethodGet, created.URL, h.memberToken, nil, "")
	if got.Code != http.StatusOK || got.Header().Get("Content-Type") != "image/gif" ||
		got.Header().Get("X-Content-Type-Options") != "nosniff" || !bytes.Equal(got.Body.Bytes(), content) {
		t.Fatalf("image response = %d %v (%d bytes)", got.Code, got.Header(), got.Body.Len())
	}
	if rec := h.do(t, http.MethodGet, created.URL, "", nil, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous image status = %d, want 401", rec.Code)
	}
	for _, path := range []string{"/api/v1/stickers/999/image", "/api/v1/stickers/abc/image", "/api/v1/stickers/0/image"} {
		if rec := h.do(t, http.MethodGet, path, h.memberToken, nil, ""); rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, rec.Code)
		}
	}
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

func TestStickerPatch_RenamesSetsEmojiAndBroadcasts(t *testing.T) {
	h := newStickerHarness(t)
	created := decodeSticker(t, h.upload(t, h.ownerToken, "Wave", "👋", pngBytes(t, 32, 32)))

	rec := h.patch(t, h.adminToken, created.ID, `{"name":"Hello There"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	if got := decodeSticker(t, rec); got.Name != "Hello There" || got.Emoji == nil || *got.Emoji != "👋" || got.URL != created.URL {
		t.Errorf("rename kept nothing: %+v", got)
	}
	if got := decodeSticker(t, h.patch(t, h.adminToken, created.ID, `{"emoji":":wave:"}`)); got.Name != "Hello There" || got.Emoji == nil || *got.Emoji != ":wave:" {
		t.Errorf("emoji set: %+v", got)
	}
	if got := decodeSticker(t, h.patch(t, h.adminToken, created.ID, `{"emoji":""}`)); got.Emoji != nil {
		t.Errorf("emoji not cleared: %+v", got)
	}
	if h.broadcaster.count() != 4 {
		t.Errorf("broadcasts = %d, want 4 (create + three patches)", h.broadcaster.count())
	}
}

func TestStickerPatch_Refusals(t *testing.T) {
	h := newStickerHarness(t)
	first := decodeSticker(t, h.upload(t, h.ownerToken, "Wave", "", pngBytes(t, 32, 32)))
	second := decodeSticker(t, h.upload(t, h.ownerToken, "Other", "", pngBytes(t, 32, 32)))
	before := h.broadcaster.count()

	cases := []struct {
		name  string
		token string
		id    int64
		body  string
		want  int
	}{
		{"member", h.memberToken, first.ID, `{"name":"Nope"}`, http.StatusForbidden},
		{"anonymous", "", first.ID, `{"name":"Nope"}`, http.StatusUnauthorized},
		{"taken name", h.ownerToken, second.ID, `{"name":"wave"}`, http.StatusConflict},
		{"bad name", h.ownerToken, first.ID, `{"name":"x"}`, http.StatusBadRequest},
		{"bad emoji", h.ownerToken, first.ID, `{"emoji":"words"}`, http.StatusBadRequest},
		{"bad json", h.ownerToken, first.ID, `{`, http.StatusBadRequest},
		{"unknown id", h.ownerToken, 999, `{"name":"Fine"}`, http.StatusNotFound},
	}
	for _, tc := range cases {
		if rec := h.patch(t, tc.token, tc.id, tc.body); rec.Code != tc.want {
			t.Errorf("%s: status = %d, want %d (%s)", tc.name, rec.Code, tc.want, rec.Body.String())
		}
	}
	if rec := h.do(t, http.MethodPatch, "/api/v1/stickers/abc", h.ownerToken, bytes.NewBufferString(`{}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Errorf("bad id status = %d, want 400", rec.Code)
	}
	if h.broadcaster.count() != before {
		t.Errorf("a refused patch broadcast")
	}
	if row, _ := h.database.GetSticker(context.Background(), first.ID); row == nil || row.Name != "Wave" {
		t.Errorf("a refused patch changed the row: %+v", row)
	}
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

func TestStickerDelete_RemovesRowFileAndBroadcasts(t *testing.T) {
	h := newStickerHarness(t)
	created := decodeSticker(t, h.upload(t, h.ownerToken, "Wave", "", pngBytes(t, 32, 32)))
	stored, err := h.database.GetSticker(context.Background(), created.ID)
	if err != nil || stored == nil {
		t.Fatalf("GetSticker = %v, %v", stored, err)
	}

	if rec := h.do(t, http.MethodDelete, fmt.Sprintf("/api/v1/stickers/%d", created.ID), h.memberToken, nil, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("member delete status = %d, want 403", rec.Code)
	}
	if row, _ := h.database.GetSticker(context.Background(), created.ID); row == nil {
		t.Fatal("a refused delete removed the row")
	}

	del := h.do(t, http.MethodDelete, fmt.Sprintf("/api/v1/stickers/%d", created.ID), h.adminToken, nil, "")
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204 (%s)", del.Code, del.Body.String())
	}
	if row, _ := h.database.GetSticker(context.Background(), created.ID); row != nil {
		t.Errorf("row still present after delete: %+v", row)
	}
	if f, oErr := h.store.Open(stored.StoredAs); oErr == nil {
		_ = f.Close()
		t.Errorf("stored file %q survived the delete", stored.StoredAs)
	}
	if h.broadcaster.count() != 2 || len(h.broadcaster.calls[1]) != 0 {
		t.Errorf("broadcasts = %+v, want create then an empty set", h.broadcaster.calls)
	}
	if img := h.do(t, http.MethodGet, created.URL, h.memberToken, nil, ""); img.Code != http.StatusNotFound {
		t.Errorf("image after delete = %d, want 404", img.Code)
	}
	if rec := h.do(t, http.MethodDelete, "/api/v1/stickers/999", h.ownerToken, nil, ""); rec.Code != http.StatusNotFound {
		t.Errorf("unknown id status = %d, want 404", rec.Code)
	}
	if rec := h.do(t, http.MethodDelete, "/api/v1/stickers/nope", h.ownerToken, nil, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("bad id status = %d, want 400", rec.Code)
	}
}

// The fan-out runs after the commit, so it must survive a request context that
// was canceled in between, as the emoji fan-out does.
func TestBroadcastStickerSet_SurvivesCanceledRequestContext(t *testing.T) {
	h := newStickerHarness(t)
	if _, err := h.database.CreateSticker(context.Background(), "Wave", nil, "stored-1", "image/png", 1); err != nil {
		t.Fatalf("CreateSticker: %v", err)
	}
	svc := service.New(h.database, auth.NewRateLimiter())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	api.BroadcastStickerSetForTest(ctx, svc, h.broadcaster)
	if h.broadcaster.count() != 1 || len(h.broadcaster.calls[0]) != 1 || h.broadcaster.calls[0][0].Name != "Wave" {
		t.Fatalf("broadcast = %+v, want the one sticker despite the canceled context", h.broadcaster.calls)
	}
}
