package api_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

// testUploadSvc wires an UploadService around the test DB so
// MountUploadRoutes can enforce its non-nil contract. The tests don't
// exercise per-channel ACLs directly — they go through the live
// permissions.Checker behind the service, which is the production path anyway.
func testUploadSvc(database *db.DB) *service.UploadService {
	return service.NewUploadService(database, service.NewPermissionService(database, permissions.NewChecker(database)))
}

// ─── schema for upload tests ─────────────────────────────────────────────────

var uploadTestSchema = []byte(schemaAccounts + `
-- AuthMiddleware falls through to an API-token lookup whenever a bearer
-- token matches no session (auth.ResolveTokenHash), so this table must exist
-- even in upload-only fixtures — otherwise an ordinary "no such session"
-- lookup for a garbage/unknown token hits GetActiveAPIToken and fails with a
-- real "no such table" SQL error instead of the intended not-found sentinel.
CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,
    label        TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at   TEXT,
    revoked_at   TEXT
);
CREATE TABLE IF NOT EXISTS channels (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    type           TEXT    NOT NULL DEFAULT 'text',
    category_id INTEGER REFERENCES channel_categories(id) ON DELETE SET NULL,
    permissions_synced INTEGER NOT NULL DEFAULT 0,
    topic          TEXT    NOT NULL DEFAULT '',
    position       INTEGER NOT NULL DEFAULT 0,
    slow_mode      INTEGER NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users INTEGER NOT NULL DEFAULT 0,
    voice_quality   TEXT,
    mixing_threshold INTEGER,
    voice_max_video INTEGER NOT NULL DEFAULT 0,
    is_group        INTEGER NOT NULL DEFAULT 0,
    nsfw            INTEGER NOT NULL DEFAULT 0,
    afk             INTEGER NOT NULL DEFAULT 0,
    parent_channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    thread_starter_message_id INTEGER,
    thread_owner_id INTEGER,
    thread_archived INTEGER NOT NULL DEFAULT 0,
    thread_locked INTEGER NOT NULL DEFAULT 0,
    thread_auto_archive_minutes INTEGER NOT NULL DEFAULT 1440,
    thread_last_activity_at TEXT,
    forum_require_tag INTEGER NOT NULL DEFAULT 0,
    forum_default_auto_archive_minutes INTEGER NOT NULL DEFAULT 4320,
    import_pending INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    password_version INTEGER NOT NULL DEFAULT 0,
    dm_owner_id     INTEGER,
    dm_icon     TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL REFERENCES channels(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    content     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    edited_at   TEXT,
    deleted     INTEGER NOT NULL DEFAULT 0,
    mentions_everyone INTEGER NOT NULL DEFAULT 0,
    pinned_at  TEXT,
    kind       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER,
    uploader_id INTEGER REFERENCES users(id),
    duration_ms INTEGER,
    waveform    TEXT
);
-- B5-2: the upload byte counter UploadService.Reserve charges before every
-- store write, so no upload succeeds without it. Keep in step with
-- migrations/044_user_storage.sql, plus quota_mb from 088.
CREATE TABLE IF NOT EXISTS user_storage (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bytes_used INTEGER NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
    quota_mb   INTEGER CHECK (quota_mb IS NULL OR quota_mb >= 0)
);
CREATE TABLE IF NOT EXISTS dm_participants (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    opened     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE IF NOT EXISTS channel_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    role_id    INTEGER NOT NULL REFERENCES roles(id),
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, role_id)
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('server_name', 'OwnCord Server'),
    ('motd', 'Welcome!');
`)

// ─── helpers ─────────────────────────────────────────────────────────────────

func newUploadTestDB(t *testing.T) *db.DB {
	t.Helper()
	return openSchemaDB(t, uploadTestSchema)
}

func newUploadTestStorage(t *testing.T) *storage.Storage {
	t.Helper()
	dir := t.TempDir()
	store, err := storage.New(dir, 10) // 10 MB max
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	return store
}

func buildUploadRouter(database *db.DB, store *storage.Storage, allowedOrigins []string) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountUploadRoutes(r, service.NewSessionService(database), store, limiter, allowedOrigins, testUploadSvc(database))
	return r
}

func buildUploadRouterWithLimiter(database *db.DB, store *storage.Storage, limiter *auth.RateLimiter, allowedOrigins []string) http.Handler {
	r := chi.NewRouter()
	if limiter == nil {
		limiter = auth.NewRateLimiter()
	}
	api.MountUploadRoutes(r, service.NewSessionService(database), store, limiter, allowedOrigins, testUploadSvc(database))
	return r
}

// uploadCreateToken creates a user+session and returns the plaintext token.
func uploadCreateToken(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	return createUserToken(t, database, "upload-test-token-", username, roleID)
}

// makeMultipartFile builds a multipart form body with a single "file" field.
func makeMultipartFile(t *testing.T, fieldName, filename string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile(fieldName, filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := io.Copy(part, bytes.NewReader(content)); err != nil {
		t.Fatalf("writing file part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("closing multipart writer: %v", err)
	}
	return body, writer.FormDataContentType()
}

// makePNGBytes generates a small valid PNG image and returns its raw bytes.
func makePNGBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			img.Set(x, y, color.RGBA{R: 255, G: 0, B: 0, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

// makeAnimatedGIFBytes encodes a two-frame GIF of the given size, padded with
// a comment extension until it is at least minBytes long (0: no padding).
func makeAnimatedGIFBytes(t *testing.T, width, height, minBytes int) []byte {
	t.Helper()
	pal := color.Palette{color.Black, color.White}
	anim := &gif.GIF{
		Image: []*image.Paletted{image.NewPaletted(image.Rect(0, 0, width, height), pal), image.NewPaletted(image.Rect(0, 0, width, height), pal)},
		Delay: []int{10, 10},
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, anim); err != nil {
		t.Fatalf("gif.EncodeAll: %v", err)
	}
	raw := buf.Bytes()
	if len(raw) >= minBytes {
		return raw
	}
	// A comment extension (0x21 0xFE) of 255-byte sub-blocks, inserted
	// before the trailer, keeps the file a valid GIF at any size.
	var pad bytes.Buffer
	pad.Write([]byte{0x21, 0xFE})
	for pad.Len() < minBytes-len(raw)+2 {
		pad.WriteByte(255)
		pad.Write(make([]byte, 255))
	}
	pad.WriteByte(0)
	out := append([]byte{}, raw[:len(raw)-1]...)
	out = append(out, pad.Bytes()...)
	return append(out, raw[len(raw)-1])
}

func doUpload(t *testing.T, router http.Handler, token, fieldName, filename string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := makeMultipartFile(t, fieldName, filename, content)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", body)
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := serveLocal(router, req)
	return rr
}

func doServeFile(t *testing.T, router http.Handler, fileID, token string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/"+fileID, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rr := serveLocal(router, req)
	return rr
}

// breakStorageDir removes the storage directory out from under an
// already-constructed Storage so Save's os.Create fails — what a disk-full,
// permission-change or read-only-mount failure looks like to a handler.
func breakStorageDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
}

// requireStorageErrorHidesPath checks a failed upload answers 507 without
// echoing the server's absolute storage path or any filesystem path.
func requireStorageErrorHidesPath(t *testing.T, rr *httptest.ResponseRecorder, dir string) {
	t.Helper()
	// Server-side filesystem failures are 507 (storage.ErrIO) so they are
	// distinguishable from bad uploads; the no-leak contract is unchanged.
	requireStatus(t, rr, http.StatusInsufficientStorage)

	resp := decodeBody[map[string]any](t, rr)
	message, _ := resp["message"].(string)
	if strings.Contains(message, dir) {
		t.Fatalf("response message leaks the absolute storage path: %q", message)
	}
	if strings.ContainsAny(message, `/\`) {
		t.Fatalf("response message looks like it contains a filesystem path: %q", message)
	}
}

// OC-0137: storage.Save's error strings embed the resolved absolute
// destination path ("creating file %s", "syncing file %s", "resolved path %q
// escapes storage directory"). handleUpload must not forward that text to the
// client — only log it — or any authenticated user who triggers a storage
// failure (disk full, permission change, read-only mount) learns the
// server's absolute storage directory layout.
func TestUpload_StorageErrorDoesNotLeakPath(t *testing.T) {
	database := newUploadTestDB(t)
	dir := t.TempDir()
	store, err := storage.New(dir, 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "leakuser", 1)

	breakStorageDir(t, dir)

	content := []byte("content that will fail to persist because the storage dir is gone")
	rr := doUpload(t, router, token, "file", "leaktest.txt", content)
	requireStorageErrorHidesPath(t, rr, dir)
}

func TestUpload_DBCreateAttachmentFailureDeletesStoredFile(t *testing.T) {
	database := newUploadTestDB(t)
	dir := t.TempDir()
	store, err := storage.New(dir, 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "dbfailupload", 1)

	if _, err := database.ExecContext(context.Background(), `CREATE TRIGGER fail_attachment_insert BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'forced'); END`); err != nil {
		t.Fatalf("fail attachment inserts: %v", err)
	}

	content := []byte("content that will save to disk before attachment insert fails")
	rr := doUpload(t, router, token, "file", "cleanup.txt", content)
	requireStatus(t, rr, http.StatusInternalServerError)

	resp := decodeBody[map[string]any](t, rr)
	if resp["error"] != "INTERNAL_ERROR" {
		t.Errorf("error = %v, want INTERNAL_ERROR", resp["error"])
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected stored file cleanup on DB failure, found %d entries", len(entries))
	}
}

func TestUpload_SanitizesReservedFilenameToUnnamed(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "sanitizeupload", 1)
	content := []byte("content for reserved filename sanitization")

	rr := doUpload(t, router, token, "file", ".", content)
	requireStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
	if resp["filename"] != "unnamed" {
		t.Fatalf("filename = %v, want unnamed", resp["filename"])
	}

	att, err := database.GetAttachmentByID(context.Background(), resp["id"].(string))
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att == nil {
		t.Fatal("expected attachment record in DB, got nil")
	}
	if att.Filename != "unnamed" {
		t.Fatalf("DB filename = %q, want unnamed", att.Filename)
	}
}

// TestUpload_StripsBidiOverrideAndForeignSeparator locks the two gaps in
// sanitizeUploadFilename. The sanitizer filtered ASCII control bytes only, so
// U+202E RIGHT-TO-LEFT OVERRIDE survived into attachments.filename and was
// reflected to every other member of the channel — and into the native save
// dialog the client pre-fills — making a script display as though it ended in
// ".txt". Separately, filepath.Base only strips the server OS's separator, so a
// backslash survived on a Linux server and is a path separator on the victim's
// Windows client.
func TestUpload_StripsBidiOverrideAndForeignSeparator(t *testing.T) {
	// Escaped rather than embedded: a literal U+202E would reorder this source
	// file in every editor and terminal that renders it — which is the whole
	// primitive under test.
	const rtlOverride = "\u202e"

	cases := []struct {
		name     string
		upload   string
		wantName string
	}{
		{
			name:     "bidi override removed",
			upload:   "Q3_Report" + rtlOverride + "txt.bat",
			wantName: "Q3_Reporttxt.bat",
		},
		{
			name:     "other invisible formatting characters removed",
			upload:   "in\u200bvoice\u2066.pdf", // ZERO WIDTH SPACE, LEFT-TO-RIGHT ISOLATE
			wantName: "invoice.pdf",
		},
		{
			name:     "backslash path stripped regardless of server OS",
			upload:   `..\..\Windows\evil.bat`,
			wantName: "evil.bat",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			database := newUploadTestDB(t)
			store := newUploadTestStorage(t)
			router := buildUploadRouter(database, store, nil)
			token := uploadCreateToken(t, database, "bidi"+strings.ReplaceAll(tc.name, " ", ""), 1)

			rr := doUpload(t, router, token, "file", tc.upload, []byte("@echo off\r\n"))
			requireStatus(t, rr, http.StatusCreated)
			resp := decodeBody[map[string]any](t, rr)
			got, _ := resp["filename"].(string)
			if got != tc.wantName {
				t.Errorf("filename = %q, want %q", got, tc.wantName)
			}

			// The stored record must match — it is what every other client renders.
			att, err := database.GetAttachmentByID(context.Background(), resp["id"].(string))
			if err != nil || att == nil {
				t.Fatalf("GetAttachmentByID: %v", err)
			}
			if att.Filename != tc.wantName {
				t.Errorf("DB filename = %q, want %q", att.Filename, tc.wantName)
			}
			if strings.ContainsAny(att.Filename, "\\/") {
				t.Errorf("stored filename %q still contains a path separator", att.Filename)
			}
		})
	}
}

func TestUpload_SuccessfulUploadCreatesDBRecord(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "dbcheck", 1)

	content := []byte("some file content for database record verification test")
	rr := doUpload(t, router, token, "file", "dbtest.txt", content)

	requireStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)

	fileID := resp["id"].(string)
	att, err := database.GetAttachmentByID(context.Background(), fileID)
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att == nil {
		t.Fatal("expected attachment record in DB")
	}
	if att.Filename != "dbtest.txt" {
		t.Errorf("filename = %q, want dbtest.txt", att.Filename)
	}
	if att.Size != int64(len(content)) {
		t.Errorf("size = %d, want %d", att.Size, len(content))
	}
	// message_id should be nil (unlinked upload).
	if att.MessageID != nil {
		t.Errorf("message_id = %v, want nil (unlinked)", att.MessageID)
	}
}

func TestUpload_ResponseFields(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "respfields", 1)

	content := []byte("response field validation content data")
	rr := doUpload(t, router, token, "file", "fields.dat", content)

	requireStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)

	// All required fields should be present.
	requiredFields := []string{"id", "filename", "size", "mime", "url"}
	for _, field := range requiredFields {
		if resp[field] == nil {
			t.Errorf("missing required field %q in response", field)
		}
	}

	// URL should contain the file ID.
	url, _ := resp["url"].(string)
	id, _ := resp["id"].(string)
	expectedURL := "/api/v1/files/" + id
	if url != expectedURL {
		t.Errorf("url = %q, want %q", url, expectedURL)
	}

	// Non-image files should not have width/height.
	if resp["width"] != nil {
		t.Errorf("expected nil width for non-image, got %v", resp["width"])
	}
	if resp["height"] != nil {
		t.Errorf("expected nil height for non-image, got %v", resp["height"])
	}
}

// ─── Table-driven tests for blocked file types ──────────────────────────────

func TestUpload_BlockedFileTypes(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		content  []byte
	}{
		{"PE executable", "test.exe", append([]byte("MZ"), make([]byte, 50)...)},
		{"ELF binary", "test.bin", append([]byte("\x7fELF"), make([]byte, 50)...)},
		{"Mach-O 64-bit", "test.macho", append([]byte("\xcf\xfa\xed\xfe"), make([]byte, 50)...)},
		{"Mach-O 32-bit", "test.macho32", append([]byte("\xce\xfa\xed\xfe"), make([]byte, 50)...)},
		{"shell script", "test.sh", []byte("#!/bin/bash\necho hello\n")},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			database := newUploadTestDB(t)
			store := newUploadTestStorage(t)
			router := buildUploadRouter(database, store, nil)
			token := uploadCreateToken(t, database, fmt.Sprintf("blocked_%s", tc.name), 1)

			rr := doUpload(t, router, token, "file", tc.filename, tc.content)
			if rr.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 for %s; body: %s", rr.Code, tc.name, rr.Body.String())
			}
		})
	}
}

// ─── End-to-end upload then serve round-trip ────────────────────────────────

func TestUpload_ThenServe_RoundTrip(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "roundtrip", 1)

	content := []byte("round trip test content for full upload and serve cycle")
	rr := doUpload(t, router, token, "file", "roundtrip.txt", content)
	requireStatus(t, rr, http.StatusCreated)

	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)
	url := uploadResp["url"].(string)

	// Serve using the URL from the upload response.
	rr2 := doAPI(t, router, http.MethodGet, url, token, nil)

	requireStatus(t, rr2, http.StatusOK)

	// Verify the served content matches what was uploaded.
	servedBody := rr2.Body.Bytes()
	if !bytes.Equal(servedBody, content) {
		t.Errorf("served content length = %d, want %d", len(servedBody), len(content))
	}

	_ = fileID // used above
}

func TestUpload_ThenServe_PNG_RoundTrip(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "pngrt", 1)

	pngData := makePNGBytes(t, 32, 32)
	rr := doUpload(t, router, token, "file", "test.png", pngData)
	requireStatus(t, rr, http.StatusCreated)

	uploadResp := decodeBody[map[string]any](t, rr)
	url := uploadResp["url"].(string)

	rr2 := doAPI(t, router, http.MethodGet, url, token, nil)

	requireStatus(t, rr2, http.StatusOK)
	if rr2.Header().Get("Content-Type") != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", rr2.Header().Get("Content-Type"))
	}

	// Verify served bytes match original.
	if !bytes.Equal(rr2.Body.Bytes(), pngData) {
		t.Error("served PNG bytes differ from uploaded bytes")
	}
}

// ─── GET /api/v1/files/{id}/thumb (P4-08) ───────────────────────────────────

func doServeThumb(t *testing.T, router http.Handler, fileID, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/"+fileID+"/thumb", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := serveLocal(router, req)
	return rr
}

// uploadForThumb uploads content as the given user and returns the file id.
func uploadForThumb(t *testing.T, router http.Handler, token, filename string, content []byte) string {
	t.Helper()
	rr := doUpload(t, router, token, "file", filename, content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload %s: %d; body: %s", filename, rr.Code, rr.Body.String())
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil || resp.ID == "" {
		t.Fatalf("upload response: %v", err)
	}
	return resp.ID
}

// solidImage is a w×h image in one colour, filled without a per-pixel loop
// (a 4000×3000 Set loop is most of a second).
func solidImage(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: color.RGBA{R: 200, G: 40, B: 40, A: 255}}, image.Point{}, draw.Src)
	return img
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

func encodeJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	return buf.Bytes()
}

// withEXIFOrientation inserts an APP1 Exif segment carrying only the
// Orientation tag right after a JPEG's SOI marker, as a phone camera writes it.
func withEXIFOrientation(jpg []byte, orientation uint16) []byte {
	tiff := []byte{
		'M', 'M', 0, 42, 0, 0, 0, 8, // big-endian TIFF header, IFD0 at 8
		0, 1, // one entry
		0x01, 0x12, 0, 3, 0, 0, 0, 1, byte(orientation >> 8), byte(orientation), 0, 0, // Orientation SHORT
		0, 0, 0, 0, // no next IFD
	}
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}
	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	out = append(out, payload...)
	return append(out, jpg[2:]...)
}

// pngBomb is a valid PNG header declaring width×height pixels over a
// one-pixel body: DecodeConfig accepts it, and a full decode would try to
// allocate the declared size.
func pngBomb(t *testing.T, width, height uint32) []byte {
	t.Helper()
	raw := encodePNG(t, solidImage(1, 1))
	// IHDR data starts after the 8-byte signature, 4-byte length, 4-byte type.
	binary.BigEndian.PutUint32(raw[16:20], width)
	binary.BigEndian.PutUint32(raw[20:24], height)
	binary.BigEndian.PutUint32(raw[29:33], crc32.ChecksumIEEE(raw[12:29]))
	return raw
}

func TestServeThumb_PNGFitsTheBox(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbpng", 4)
	id := uploadForThumb(t, router, token, "big.png", encodePNG(t, solidImage(4000, 3000)))

	rr := doServeThumb(t, router, id, token)
	requireStatus(t, rr, http.StatusOK)
	if ct := rr.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	if rr.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("thumbnail served without nosniff")
	}
	if cc := rr.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Errorf("Cache-Control = %q, want the original's private, no-cache", cc)
	}
	cfg, format, err := image.DecodeConfig(rr.Body)
	if err != nil || format != "png" {
		t.Fatalf("thumbnail does not decode as PNG: %v (%s)", err, format)
	}
	if cfg.Width != 800 || cfg.Height != 600 {
		t.Errorf("thumbnail = %dx%d, want 800x600 (the 4000x3000 original in an 800 box)", cfg.Width, cfg.Height)
	}
	if f, err := store.OpenThumb(id); err != nil {
		t.Errorf("thumbnail not kept for the next request: %v", err)
	} else {
		_ = f.Close()
	}
}

func TestServeThumb_JPEGFitsTheBox(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbjpg", 4)
	id := uploadForThumb(t, router, token, "photo.jpg", encodeJPEG(t, solidImage(1200, 2400)))

	for range 2 { // generated, then served from the kept thumbnail
		rr := doServeThumb(t, router, id, token)
		if rr.Code != http.StatusOK || rr.Header().Get("Content-Type") != "image/jpeg" {
			t.Fatalf("thumb: %d %q", rr.Code, rr.Header().Get("Content-Type"))
		}
		cfg, format, err := image.DecodeConfig(rr.Body)
		if err != nil || format != "jpeg" || cfg.Width != 400 || cfg.Height != 800 {
			t.Fatalf("thumbnail = %dx%d %s (%v), want a 400x800 JPEG", cfg.Width, cfg.Height, format, err)
		}
	}
}

// A phone photo stores its pixels sideways with an EXIF Orientation tag the
// webview honours for the original; the thumbnail must come out upright too.
func TestServeThumb_JPEGHonoursEXIFOrientation(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "thumbexif", 4)
	// Stored sideways: the left half (blue) is the photo's top.
	src := solidImage(1600, 1000)
	draw.Draw(src, image.Rect(0, 0, 800, 1000), &image.Uniform{C: color.RGBA{B: 255, A: 255}}, image.Point{}, draw.Src)
	id := uploadForThumb(t, router, token, "phone.jpg", withEXIFOrientation(encodeJPEG(t, src), 6))

	rr := doServeThumb(t, router, id, token)
	thumb, _, err := image.Decode(rr.Body)
	if rr.Code != http.StatusOK || err != nil {
		t.Fatalf("thumb: %d, %v", rr.Code, err)
	}
	if b := thumb.Bounds(); b.Dx() != 500 || b.Dy() != 800 {
		t.Fatalf("thumbnail = %dx%d, want 500x800 (rotated upright)", b.Dx(), b.Dy())
	}
	if _, _, blue, _ := thumb.At(250, 100).RGBA(); blue < 0x8000 {
		t.Error("the photo's top (blue) is not at the thumbnail's top")
	}
}

// A sideways-stored phone photo records its upright size, so clients
// reserve a portrait box for it.
func TestUpload_JPEGDimensionsHonourEXIFOrientation(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "dimsexif", 4)
	for _, tc := range []struct {
		orientation, wantW, wantH int
	}{{1, 40, 30}, {3, 40, 30}, {6, 30, 40}, {8, 30, 40}} {
		content := withEXIFOrientation(encodeJPEG(t, solidImage(40, 30)), uint16(tc.orientation))
		rr := doUpload(t, router, token, "file", "phone.jpg", content)
		if rr.Code != http.StatusCreated {
			t.Fatalf("orientation %d: upload %d; body: %s", tc.orientation, rr.Code, rr.Body.String())
		}
		var resp struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		}
		if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
			t.Fatalf("orientation %d: decode: %v", tc.orientation, err)
		}
		if resp.Width != tc.wantW || resp.Height != tc.wantH {
			t.Errorf("orientation %d: %dx%d, want %dx%d", tc.orientation, resp.Width, resp.Height, tc.wantW, tc.wantH)
		}
	}
}

// Anything the server does not thumbnail — an image already inside the box,
// an animated GIF — is passed through as the original bytes.
func TestServeThumb_PassesThroughSmallImagesAndGIFs(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbpass", 4)
	var gifBuf bytes.Buffer
	if err := gif.Encode(&gifBuf, image.NewPaletted(image.Rect(0, 0, 1000, 1000), color.Palette{color.Black, color.White}), nil); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string][]byte{
		"small.png": encodePNG(t, solidImage(300, 200)),
		"anim.gif":  gifBuf.Bytes(),
	} {
		id := uploadForThumb(t, router, token, name, content)
		rr := doServeThumb(t, router, id, token)
		if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), content) {
			t.Errorf("%s: %d, %d bytes; want the original's %d bytes", name, rr.Code, rr.Body.Len(), len(content))
		}
		if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s: a pass-through stored a thumbnail: %v", name, err)
		}
	}
}

func TestServeThumb_NonImageIsNotFound(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "thumbtxt", 4)
	id := uploadForThumb(t, router, token, "notes.txt", []byte("plain text, not an image"))
	if rr := doServeThumb(t, router, id, token); rr.Code != http.StatusNotFound {
		t.Errorf("thumb of a text file: %d, want 404", rr.Code)
	}
}

// A decompression bomb — a header declaring far more pixels than the cap — is
// refused before a full decode, which would try to allocate the declared
// 10 gigapixels; the original is passed through untouched instead.
func TestServeThumb_DecompressionBombIsNotDecoded(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbbomb", 4)
	bomb := pngBomb(t, 100_000, 100_000)
	id := uploadForThumb(t, router, token, "bomb.png", bomb)

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), bomb) {
		t.Errorf("bomb: %d, %d bytes; want the original passed through", rr.Code, rr.Body.Len())
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a thumbnail was made of the bomb: %v", err)
	}
}

// The decode cap counts a 16-bit image at 8 bytes a pixel, so it refuses one
// at fewer pixels than an 8-bit image: this 25-megapixel 16-bit PNG, a few KB
// on disk, is over the cap and is passed through without a decode.
func TestServeThumb_Large16BitPNGIsNotDecoded(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumb16", 4)
	content := encodePNG(t, image.NewGray16(image.Rect(0, 0, 5000, 5000)))
	id := uploadForThumb(t, router, token, "deep.png", content)

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), content) {
		t.Errorf("16-bit PNG: %d, %d bytes; want the original passed through", rr.Code, rr.Body.Len())
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a thumbnail was made of the 16-bit PNG: %v", err)
	}
}

// A 4500x4500 16-bit PNG, about 160 KB on disk, would take over 150 MiB to
// decode and more again to scale: it is over the cap and passed through.
func TestServeThumb_16BitPNG4500IsNotDecoded(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumb16b", 4)
	content := encodePNG(t, image.NewGray16(image.Rect(0, 0, 4500, 4500)))
	id := uploadForThumb(t, router, token, "deep4500.png", content)

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), content) {
		t.Errorf("4500x4500 16-bit PNG: %d, %d bytes; want the original passed through", rr.Code, rr.Body.Len())
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a thumbnail was made of the 4500x4500 16-bit PNG: %v", err)
	}
}

// A baseline JPEG is counted at its decoded image alone, so a 24-megapixel
// camera photo gets a real thumbnail.
func TestServeThumb_LargeBaselineJPEGFitsTheBox(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbbaseline", 4)
	id := uploadForThumb(t, router, token, "camera.jpg", encodeJPEG(t, solidImage(6000, 4000)))

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || rr.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("thumb: %d %q", rr.Code, rr.Header().Get("Content-Type"))
	}
	cfg, format, err := image.DecodeConfig(rr.Body)
	if err != nil || format != "jpeg" || cfg.Width != 800 || cfg.Height != 533 {
		t.Fatalf("thumbnail = %dx%d %s (%v), want an 800x533 JPEG", cfg.Width, cfg.Height, format, err)
	}
}

// A progressive JPEG's decode is counted at three times its decoded image,
// for the coefficient blocks it holds: this 20-megapixel greyscale JPEG, small
// on disk, is under the cap counted as a baseline JPEG but over it counted as
// a progressive one, and is passed through without a decode. Go encodes only
// baseline, so its SOF0 marker is patched to SOF2; the body is never decoded.
func TestServeThumb_LargeProgressiveJPEGIsNotDecoded(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbbigjpg", 4)
	content := encodeJPEG(t, image.NewGray(image.Rect(0, 0, 5000, 4000)))
	sof := bytes.Index(content, []byte{0xFF, 0xC0})
	if sof < 0 {
		t.Fatal("no SOF0 marker in the encoded JPEG")
	}
	content[sof+1] = 0xC2
	id := uploadForThumb(t, router, token, "wide.jpg", content)

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), content) {
		t.Errorf("large progressive JPEG: %d, %d bytes; want the original passed through", rr.Code, rr.Body.Len())
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a thumbnail was made of the large progressive JPEG: %v", err)
	}
}

// A JPEG whose header is valid but whose body does not decode is decoded
// once; the failure is kept, and later requests pass the original through
// without decoding it again. The original is swapped for a decodable one
// after the first request to show the second never decodes.
func TestServeThumb_UndecodableJPEGIsDecodedOnce(t *testing.T) {
	database := newUploadTestDB(t)
	dir := t.TempDir()
	store, err := storage.New(dir, 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbbroken", 4)
	full := encodeJPEG(t, solidImage(1200, 900))
	broken := full[:len(full)/2]
	id := uploadForThumb(t, router, token, "broken.jpg", broken)

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), broken) {
		t.Fatalf("broken JPEG: %d, %d bytes; want the original passed through", rr.Code, rr.Body.Len())
	}
	assertNoThumbKept := func() {
		t.Helper()
		f, err := store.OpenThumb(id)
		if err != nil {
			t.Fatalf("the failed decode was not kept: %v", err)
		}
		defer f.Close() //nolint:errcheck
		if info, err := f.Stat(); err != nil || info.Size() != 0 {
			t.Fatalf("kept thumbnail of a broken JPEG: %v, %v", info, err)
		}
	}
	assertNoThumbKept()

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var originals []string
	for _, e := range entries {
		if e.Type().IsRegular() {
			originals = append(originals, e.Name())
		}
	}
	if len(originals) != 1 {
		t.Fatalf("storage holds %v, want one original", originals)
	}
	decodable := encodeJPEG(t, solidImage(1200, 2400))
	if err := os.WriteFile(filepath.Join(dir, originals[0]), decodable, 0o600); err != nil {
		t.Fatal(err)
	}

	rr = doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), decodable) {
		t.Errorf("second request: %d, %d bytes; want the original passed through undecoded", rr.Code, rr.Body.Len())
	}
	assertNoThumbKept()
}

func TestServeThumb_Unauthenticated(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "thumbanon", 4)
	id := uploadForThumb(t, router, token, "a.png", encodePNG(t, solidImage(1000, 1000)))
	if rr := doServeThumb(t, router, id, ""); rr.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated thumb: %d, want 401", rr.Code)
	}
}

// The thumbnail is the same content as the file, so it answers to the same
// access rule: a member without READ_MESSAGES on the channel gets 403.
func TestServeThumb_MemberWithoutReadForbidden(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	uploaderToken := uploadCreateToken(t, database, "thumbowner", 1)
	memberToken := uploadCreateToken(t, database, "thumbnoperm", 4)
	id := uploadForThumb(t, router, uploaderToken, "secret.png", encodePNG(t, solidImage(1000, 1000)))

	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO channels (id, name, type) VALUES (1, 'secret', 'text')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO messages (id, channel_id, user_id, content) SELECT 1, 1, id, 'x' FROM users WHERE username = 'thumbowner'`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE attachments SET message_id = 1 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (1, 4, 0, 2)`); err != nil {
		t.Fatal(err)
	}
	if rr := doServeThumb(t, router, id, memberToken); rr.Code != http.StatusForbidden {
		t.Errorf("thumb without READ_MESSAGES: %d, want 403", rr.Code)
	}
	if rr := doServeThumb(t, router, id, uploaderToken); rr.Code != http.StatusOK {
		t.Errorf("thumb for a reader: %d, want 200", rr.Code)
	}
}

// ─── multipart tail ─────────────────────────────────────────────────────────

func rawUpload(t *testing.T, h *quotaHarness, contentType string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+h.token)
	rr := serveLocal(h.router, req)
	return rr
}

func attachmentCount(t *testing.T, h *quotaHarness) int {
	t.Helper()
	var n int
	if err := h.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM attachments`).Scan(&n); err != nil {
		t.Fatalf("count attachments: %v", err)
	}
	return n
}

// A part after the file is still request body: bytes past the body cap are
// refused with 413 and nothing is recorded or kept.
func TestUpload_TrailingPartBeyondBodyCapIs413(t *testing.T) {
	if testing.Short() {
		t.Skip("streams a 100 MiB tail")
	}
	h := cappedHarness(t, 10)
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		part, err := mw.CreateFormFile("file", "a.txt")
		if err == nil {
			_, err = part.Write([]byte("hello world this is a text file"))
		}
		if err == nil {
			part, err = mw.CreateFormField("pad")
		}
		if err == nil {
			_, err = io.CopyN(part, zeroReader{}, 101<<20)
		}
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()
	rr := rawUpload(t, h, mw.FormDataContentType(), pr)
	_ = pr.CloseWithError(io.ErrClosedPipe)
	assertErrorCode(t, rr, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE")
	if n := attachmentCount(t, h); n != 0 {
		t.Fatalf("attachments = %d, want 0", n)
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a refused upload left a file on disk")
	}
	if got := h.used(t); got != 0 {
		t.Fatalf("storage used = %d, want 0", got)
	}
}

// A tail that stops mid-part is a malformed body, not a finished upload.
func TestUpload_MalformedTailIs400(t *testing.T) {
	h := cappedHarness(t, 10)
	body := "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\n\r\n" +
		"hello world this is a text file\r\n" +
		"--B\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\nvalue-without-closing-boundary"
	rr := rawUpload(t, h, "multipart/form-data; boundary=B", strings.NewReader(body))
	assertErrorCode(t, rr, http.StatusBadRequest, "BAD_REQUEST")
	if n := attachmentCount(t, h); n != 0 {
		t.Fatalf("attachments = %d, want 0", n)
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a refused upload left a file on disk")
	}
}

// quickTimeHeader is the start of an iPhone-style .mov: an ftyp box whose only
// brand is "qt  ". http.DetectContentType knows no QuickTime signature, so
// without the upload handler's own check it lands as application/octet-stream
// and the client shows a download chip instead of a player.
func quickTimeHeader() []byte {
	data := make([]byte, 64)
	copy(data, "\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  ")
	copy(data[20:], "\x00\x00\x00\x08wide")
	return data
}

func TestUpload_SniffsQuickTimeAsVideo(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "movuser", 1)

	rr := doUpload(t, router, token, "file", "clip.mov", quickTimeHeader())
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
	if resp["mime"] != "video/quicktime" {
		t.Errorf("mime = %v, want video/quicktime", resp["mime"])
	}
}

// A <video> element seeks with Range requests; the served video must answer
// one with 206, the requested slice and its real Content-Type.
func TestServeFile_VideoHonoursRangeWithItsContentType(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "rangeuser", 1)

	content := quickTimeHeader()
	rr := doUpload(t, router, token, "file", "clip.mov", content)
	requireStatus(t, rr, http.StatusCreated)
	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)

	rr2 := doServeFile(t, router, fileID, token, map[string]string{"Range": "bytes=4-11"})
	if rr2.Code != http.StatusPartialContent {
		t.Fatalf("serve status = %d, want 206", rr2.Code)
	}
	if ct := rr2.Header().Get("Content-Type"); ct != "video/quicktime" {
		t.Errorf("Content-Type = %q, want video/quicktime", ct)
	}
	if cr := rr2.Header().Get("Content-Range"); cr != fmt.Sprintf("bytes 4-11/%d", len(content)) {
		t.Errorf("Content-Range = %q", cr)
	}
	if got := rr2.Body.String(); got != "ftypqt  " {
		t.Errorf("body = %q, want the requested slice", got)
	}
	if ar := rr2.Header().Get("Accept-Ranges"); ar != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes", ar)
	}
}
