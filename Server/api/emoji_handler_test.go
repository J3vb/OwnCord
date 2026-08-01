package api_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/service"
	"github.com/owncord/server/storage"
)

// ─── harness ─────────────────────────────────────────────────────────────────

// recordingEmojiBroadcaster captures every emoji_update fan-out so a test can
// assert the set was pushed (and what it contained) without a live hub.
type recordingEmojiBroadcaster struct {
	calls [][]*db.Emoji
}

func (b *recordingEmojiBroadcaster) BroadcastEmojiUpdate(list []*db.Emoji) {
	b.calls = append(b.calls, list)
}

type emojiHarness struct {
	router      http.Handler
	database    *db.DB
	store       *storage.Storage
	broadcaster *recordingEmojiBroadcaster
	// Tokens for the three principals the gate tests need.
	ownerToken  string // ADMINISTRATOR
	adminToken  string // MANAGE_SERVER, no ADMINISTRATOR
	memberToken string // neither
}

func newEmojiHarness(t *testing.T) *emojiHarness {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	// Pin the exact permission masks the gate tests depend on rather than
	// inheriting whatever the seeded defaults happen to carry.
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

	store, err := storage.New(t.TempDir(), 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}

	h := &emojiHarness{
		database:    database,
		store:       store,
		broadcaster: &recordingEmojiBroadcaster{},
	}
	svc := service.New(database, auth.NewRateLimiter())
	r := chi.NewRouter()
	api.MountEmojiRoutes(r, database, svc, store, auth.NewRateLimiter(), h.broadcaster)
	h.router = r

	h.ownerToken = emojiSeedUser(t, database, "owner", int(permissions.OwnerRoleID))
	h.adminToken = emojiSeedUser(t, database, "admin", int(permissions.AdminRoleID))
	h.memberToken = emojiSeedUser(t, database, "member", int(permissions.MemberRoleID))
	return h
}

// emojiSeedUser creates a user with roleID and an unexpired session, returning
// the plaintext bearer token.
func emojiSeedUser(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	if _, err := database.CreateUser(context.Background(), username, "$2a$12$fake", roleID); err != nil {
		t.Fatalf("CreateUser %q: %v", username, err)
	}
	token := "emoji-test-token-" + username
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 SELECT id, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z' FROM users WHERE username = ?`,
		auth.HashToken(token), username)
	if err != nil {
		t.Fatalf("insert session for %q: %v", username, err)
	}
	return token
}

func (h *emojiHarness) do(t *testing.T, method, path, token string, body *bytes.Buffer, contentType string) *httptest.ResponseRecorder {
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

// upload POSTs a multipart emoji and returns the recorder.
func (h *emojiHarness) upload(t *testing.T, token, shortcode string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	if shortcode != "" {
		if err := w.WriteField("shortcode", shortcode); err != nil {
			t.Fatalf("WriteField: %v", err)
		}
	}
	if content != nil {
		part, err := w.CreateFormFile("file", "emoji.bin")
		if err != nil {
			t.Fatalf("CreateFormFile: %v", err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatalf("write part: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return h.do(t, http.MethodPost, "/api/v1/emoji", token, body, w.FormDataContentType())
}

// ─── image fixtures ──────────────────────────────────────────────────────────

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

func gifBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		t.Fatalf("gif.Encode: %v", err)
	}
	return buf.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	return buf.Bytes()
}

// webpVP8LBytes builds the smallest byte sequence that both sniffs as
// image/webp and carries a readable lossless header of the given size. Go has
// no WebP encoder, so the container is written by hand — which is also what the
// dimension reader under test parses.
func webpVP8LBytes(w, h int) []byte {
	buf := make([]byte, 30)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:8], uint32(len(buf)-8))
	copy(buf[8:12], "WEBP")
	copy(buf[12:16], "VP8L")
	binary.LittleEndian.PutUint32(buf[16:20], uint32(len(buf)-20))
	buf[20] = 0x2F
	bits := uint32(w-1) | uint32(h-1)<<14
	binary.LittleEndian.PutUint32(buf[21:25], bits)
	return buf
}

// ─── GET /api/v1/emoji ───────────────────────────────────────────────────────

func TestEmojiList_RequiresAuth(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.do(t, http.MethodGet, "/api/v1/emoji", "", nil, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestEmojiList_EmptyIsJSONArray(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.do(t, http.MethodGet, "/api/v1/emoji", h.memberToken, nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Errorf("body = %q, want []", got)
	}
}

func TestEmojiList_AnyMemberMaySee(t *testing.T) {
	h := newEmojiHarness(t)
	if rec := h.upload(t, h.ownerToken, "wave", pngBytes(t, 64, 64)); rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d (%s)", rec.Code, rec.Body.String())
	}

	rec := h.do(t, http.MethodGet, "/api/v1/emoji", h.memberToken, nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var list []struct {
		ID        int64  `json:"id"`
		Shortcode string `json:"shortcode"`
		URL       string `json:"url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("len = %d, want 1", len(list))
	}
	if list[0].Shortcode != "wave" {
		t.Errorf("shortcode = %q, want wave", list[0].Shortcode)
	}
	if want := fmt.Sprintf("/api/v1/emoji/%d/image", list[0].ID); list[0].URL != want {
		t.Errorf("url = %q, want %q", list[0].URL, want)
	}
}

// ─── POST permission gate ────────────────────────────────────────────────────

func TestEmojiUpload_MemberIsForbidden(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.upload(t, h.memberToken, "wave", pngBytes(t, 64, 64))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}
	if len(h.broadcaster.calls) != 0 {
		t.Errorf("broadcast fired on a refused upload")
	}
}

func TestEmojiUpload_ManageServerIsEnough(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.upload(t, h.adminToken, "wave", pngBytes(t, 64, 64))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
	if len(h.broadcaster.calls) != 1 {
		t.Fatalf("broadcast calls = %d, want 1", len(h.broadcaster.calls))
	}
	if got := h.broadcaster.calls[0]; len(got) != 1 || got[0].Shortcode != "wave" {
		t.Errorf("broadcast payload = %+v, want one :wave:", got)
	}
}

func TestEmojiUpload_Unauthenticated(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.upload(t, "", "wave", pngBytes(t, 64, 64))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// ─── POST validation ─────────────────────────────────────────────────────────

func TestEmojiUpload_AcceptsEveryAllowedFormat(t *testing.T) {
	h := newEmojiHarness(t)
	cases := map[string][]byte{
		"apng":  pngBytes(t, 128, 128),
		"agif":  gifBytes(t, 100, 100),
		"ajpeg": jpegBytes(t, 64, 32),
		"awebp": webpVP8LBytes(48, 48),
	}
	for shortcode, content := range cases {
		rec := h.upload(t, h.ownerToken, shortcode, content)
		if rec.Code != http.StatusCreated {
			t.Errorf("%s: status = %d, want 201 (%s)", shortcode, rec.Code, rec.Body.String())
		}
	}
}

func TestEmojiUpload_RejectsNonImage(t *testing.T) {
	h := newEmojiHarness(t)
	// A plain-text body sniffs as text/plain, which is not in the allowlist.
	rec := h.upload(t, h.ownerToken, "wave", []byte("this is definitely not an image at all"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "PNG") {
		t.Errorf("message = %q, want the format list", rec.Body.String())
	}
}

func TestEmojiUpload_RejectsSVG(t *testing.T) {
	h := newEmojiHarness(t)
	svg := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
		`<script>alert(1)</script></svg>`)
	rec := h.upload(t, h.ownerToken, "wave", svg)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}

func TestEmojiUpload_RejectsOversizeDimensions(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.upload(t, h.ownerToken, "toobig", pngBytes(t, 129, 64))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "128x128") {
		t.Errorf("message = %q, want the pixel cap", rec.Body.String())
	}
	// Same for height, and for a WebP whose header is what carries the size.
	if rec := h.upload(t, h.ownerToken, "tootall", pngBytes(t, 64, 200)); rec.Code != http.StatusBadRequest {
		t.Errorf("tall png status = %d, want 400", rec.Code)
	}
	if rec := h.upload(t, h.ownerToken, "widewebp", webpVP8LBytes(400, 40)); rec.Code != http.StatusBadRequest {
		t.Errorf("wide webp status = %d, want 400", rec.Code)
	}
}

func TestEmojiUpload_AcceptsExactlyMaxDimension(t *testing.T) {
	h := newEmojiHarness(t)
	if rec := h.upload(t, h.ownerToken, "edge", pngBytes(t, 128, 128)); rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
}

func TestEmojiUpload_RejectsOversizeFile(t *testing.T) {
	h := newEmojiHarness(t)
	// A 128x128 PNG of pure noise compresses badly enough to blow the 512 KB
	// budget while staying inside the pixel cap, which is the case the byte
	// limit exists for.
	big := make([]byte, 600<<10)
	copy(big, pngBytes(t, 128, 128))
	rec := h.upload(t, h.ownerToken, "huge", big)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}

func TestEmojiUpload_RejectsBadShortcode(t *testing.T) {
	h := newEmojiHarness(t)
	for _, sc := range []string{"", "a", "has space", "dash-es", strings.Repeat("x", 33)} {
		rec := h.upload(t, h.ownerToken, sc, pngBytes(t, 32, 32))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("shortcode %q: status = %d, want 400 (%s)", sc, rec.Code, rec.Body.String())
		}
	}
}

func TestEmojiUpload_MissingFile(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.upload(t, h.ownerToken, "wave", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}

func TestEmojiUpload_DuplicateShortcodeIsConflict(t *testing.T) {
	h := newEmojiHarness(t)
	if rec := h.upload(t, h.ownerToken, "wave", pngBytes(t, 32, 32)); rec.Code != http.StatusCreated {
		t.Fatalf("first upload status = %d", rec.Code)
	}
	rec := h.upload(t, h.ownerToken, "WAVE", pngBytes(t, 32, 32))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body.String())
	}
	// The losing upload must not leave its bytes behind.
	list, err := h.database.ListEmoji(context.Background())
	if err != nil {
		t.Fatalf("ListEmoji: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("len(list) = %d, want 1", len(list))
	}
}

// ─── GET image ───────────────────────────────────────────────────────────────

func TestEmojiImage_ServesStoredBytes(t *testing.T) {
	h := newEmojiHarness(t)
	content := gifBytes(t, 40, 40)
	rec := h.upload(t, h.ownerToken, "wave", content)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d (%s)", rec.Code, rec.Body.String())
	}
	var created struct {
		ID  int64  `json:"id"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	got := h.do(t, http.MethodGet, created.URL, h.memberToken, nil, "")
	if got.Code != http.StatusOK {
		t.Fatalf("image status = %d, want 200", got.Code)
	}
	if ct := got.Header().Get("Content-Type"); ct != "image/gif" {
		t.Errorf("Content-Type = %q, want image/gif", ct)
	}
	if got.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("missing nosniff header")
	}
	if !bytes.Equal(got.Body.Bytes(), content) {
		t.Errorf("served %d bytes, want the %d uploaded", got.Body.Len(), len(content))
	}
}

func TestEmojiImage_RequiresAuth(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.do(t, http.MethodGet, "/api/v1/emoji/1/image", "", nil, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestEmojiImage_UnknownIDIs404(t *testing.T) {
	h := newEmojiHarness(t)
	for _, path := range []string{"/api/v1/emoji/999/image", "/api/v1/emoji/abc/image", "/api/v1/emoji/0/image"} {
		rec := h.do(t, http.MethodGet, path, h.memberToken, nil, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, rec.Code)
		}
	}
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

func TestEmojiDelete_RemovesRowFileAndBroadcasts(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.upload(t, h.ownerToken, "wave", pngBytes(t, 32, 32))
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d", rec.Code)
	}
	var created struct {
		ID  int64  `json:"id"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	stored, err := h.database.GetEmoji(context.Background(), created.ID)
	if err != nil || stored == nil {
		t.Fatalf("GetEmoji = %v, %v", stored, err)
	}

	del := h.do(t, http.MethodDelete, fmt.Sprintf("/api/v1/emoji/%d", created.ID), h.ownerToken, nil, "")
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204 (%s)", del.Code, del.Body.String())
	}

	if row, gErr := h.database.GetEmoji(context.Background(), created.ID); gErr != nil || row != nil {
		t.Errorf("row still present after delete: %v, %v", row, gErr)
	}
	if f, oErr := h.store.Open(stored.StoredAs); oErr == nil {
		_ = f.Close()
		t.Errorf("stored file %q survived the delete", stored.StoredAs)
	}
	if len(h.broadcaster.calls) != 2 {
		t.Fatalf("broadcast calls = %d, want 2 (create + delete)", len(h.broadcaster.calls))
	}
	if last := h.broadcaster.calls[1]; len(last) != 0 {
		t.Errorf("post-delete broadcast = %+v, want empty", last)
	}
	// The image route follows the row.
	if img := h.do(t, http.MethodGet, created.URL, h.memberToken, nil, ""); img.Code != http.StatusNotFound {
		t.Errorf("image after delete = %d, want 404", img.Code)
	}
}

func TestEmojiDelete_MemberIsForbidden(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.upload(t, h.ownerToken, "wave", pngBytes(t, 32, 32))
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d", rec.Code)
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	del := h.do(t, http.MethodDelete, fmt.Sprintf("/api/v1/emoji/%d", created.ID), h.memberToken, nil, "")
	if del.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", del.Code, del.Body.String())
	}
	if row, err := h.database.GetEmoji(context.Background(), created.ID); err != nil || row == nil {
		t.Errorf("refused delete removed the row anyway")
	}
}

func TestEmojiDelete_UnknownIDIs404(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.do(t, http.MethodDelete, "/api/v1/emoji/999", h.ownerToken, nil, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body.String())
	}
}

func TestEmojiDelete_BadIDIs400(t *testing.T) {
	h := newEmojiHarness(t)
	rec := h.do(t, http.MethodDelete, "/api/v1/emoji/not-a-number", h.ownerToken, nil, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}

// ─── WebP header parsing ─────────────────────────────────────────────────────

func TestWebPDimensions_AllChunkFlavours(t *testing.T) {
	// VP8L is covered by webpVP8LBytes; build a VP8 (lossy) and a VP8X
	// (extended) container too, since each encodes its size differently.
	vp8 := make([]byte, 30)
	copy(vp8[0:4], "RIFF")
	copy(vp8[8:12], "WEBP")
	copy(vp8[12:16], "VP8 ")
	vp8[23], vp8[24], vp8[25] = 0x9d, 0x01, 0x2a
	binary.LittleEndian.PutUint16(vp8[26:28], 100)
	binary.LittleEndian.PutUint16(vp8[28:30], 80)

	vp8x := make([]byte, 30)
	copy(vp8x[0:4], "RIFF")
	copy(vp8x[8:12], "WEBP")
	copy(vp8x[12:16], "VP8X")
	vp8x[24], vp8x[25], vp8x[26] = 0x63, 0x00, 0x00 // width-1 = 99
	vp8x[27], vp8x[28], vp8x[29] = 0x4F, 0x00, 0x00 // height-1 = 79

	cases := map[string]struct {
		raw  []byte
		w, h int
	}{
		"lossy (VP8)":     {vp8, 100, 80},
		"extended (VP8X)": {vp8x, 100, 80},
		"lossless (VP8L)": {webpVP8LBytes(100, 80), 100, 80},
	}
	for name, c := range cases {
		w, h, err := api.WebPDimensionsForTest(c.raw)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if w != c.w || h != c.h {
			t.Errorf("%s: got %dx%d, want %dx%d", name, w, h, c.w, c.h)
		}
	}
}

func TestWebPDimensions_RejectsMalformed(t *testing.T) {
	bad := [][]byte{
		nil,
		[]byte("RIFF"),
		append([]byte("RIFF0000NOTWVP8L"), make([]byte, 14)...),
		append([]byte("RIFF0000WEBPXXXX"), make([]byte, 14)...),
		append([]byte("RIFF0000WEBPVP8L"), make([]byte, 4)...), // truncated
	}
	for i, raw := range bad {
		if _, _, err := api.WebPDimensionsForTest(raw); err == nil {
			t.Errorf("case %d: want error", i)
		}
	}
}
