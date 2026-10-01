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
	"testing/fstest"

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

var uploadTestSchema = []byte(`
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner',     '#E74C3C', 2147483647, 100, 0),
    (2, 'Admin',     '#F39C12', 1073741823,  80, 0),
    (3, 'Moderator', '#3498DB', 1048575,     60, 0),
    (4, 'Member',    NULL,      1635,     40, 1);

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role_id     INTEGER NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT    NOT NULL DEFAULT 'offline',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT,
    registration_status TEXT NOT NULL DEFAULT 'active',
    identity_public_key TEXT,
    display_name TEXT,
    about TEXT,
    custom_status TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL,
    unseen     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recovery_kits (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier   TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    used_at    TEXT
);
CREATE TABLE IF NOT EXISTS recovery_assists (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    issued_by INTEGER NOT NULL,
    verification TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

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
    category       TEXT    NOT NULL DEFAULT '',
    topic          TEXT    NOT NULL DEFAULT '',
    position       INTEGER NOT NULL DEFAULT 0,
    slow_mode      INTEGER NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users INTEGER NOT NULL DEFAULT 0,
    is_group        INTEGER NOT NULL DEFAULT 0,
    nsfw            INTEGER NOT NULL DEFAULT 0
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
    pinned_at  TEXT
);
CREATE TABLE IF NOT EXISTS message_mentions (
    message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mentioned_user_id INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, mentioned_user_id)
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
    uploader_id INTEGER REFERENCES users(id)
);
-- B5-2: the upload byte counter UploadService.Reserve charges before every
-- store write, so no upload succeeds without it. Keep in step with
-- migrations/044_user_storage.sql.
CREATE TABLE IF NOT EXISTS user_storage (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bytes_used INTEGER NOT NULL DEFAULT 0 CHECK (bytes_used >= 0)
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

CREATE TABLE IF NOT EXISTS channel_user_overrides (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    allow      INTEGER NOT NULL DEFAULT 0,
    deny       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
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
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	migrFS := fstest.MapFS{"001_schema.sql": {Data: uploadTestSchema}}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
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
	_, err := database.CreateUser(context.Background(), username, "$2a$12$fake", roleID)
	if err != nil {
		t.Fatalf("CreateUser %q: %v", username, err)
	}
	token := "upload-test-token-" + username
	hash := auth.HashToken(token)
	_, err = database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 SELECT id, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z' FROM users WHERE username = ?`,
		hash, username,
	)
	if err != nil {
		t.Fatalf("insert session for %q: %v", username, err)
	}
	return token
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

func doUpload(t *testing.T, router http.Handler, token, fieldName, filename string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := makeMultipartFile(t, fieldName, filename, content)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", body)
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
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
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// ─── MountUploadRoutes ──────────────────────────────────────────────────────

func TestUpload_RoutesAreMounted(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "routeuser", 1)

	// POST /api/v1/uploads should not return 404/405.
	body, contentType := makeMultipartFile(t, "file", "test.txt", []byte("hello"))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code == http.StatusNotFound || rr.Code == http.StatusMethodNotAllowed {
		t.Errorf("POST /api/v1/uploads returned %d, route not mounted", rr.Code)
	}

	// GET /api/v1/files/{id} should not return 405 (401 or 404 are valid).
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/files/some-id", nil)
	req2.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req2)
	if rr2.Code == http.StatusMethodNotAllowed {
		t.Errorf("GET /api/v1/files/{id} returned 405, route not mounted")
	}
}

// ─── handleUpload ───────────────────────────────────────────────────────────

func TestUpload_Success_TextFile(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "uploader1", 1)

	content := []byte("hello world this is a text file with enough bytes for detection")
	rr := doUpload(t, router, token, "file", "notes.txt", content)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["filename"] != "notes.txt" {
		t.Errorf("filename = %v, want notes.txt", resp["filename"])
	}
	if resp["url"] == nil || resp["url"] == "" {
		t.Error("expected non-empty url in response")
	}
	if resp["id"] == nil || resp["id"] == "" {
		t.Error("expected non-empty id in response")
	}
	if resp["mime"] == nil || resp["mime"] == "" {
		t.Error("expected non-empty mime in response")
	}

	// Verify attachment record was created in DB.
	att, err := database.GetAttachmentByID(context.Background(), resp["id"].(string))
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att == nil {
		t.Fatal("expected attachment record in DB, got nil")
	}
	if att.Filename != "notes.txt" {
		t.Errorf("DB filename = %q, want notes.txt", att.Filename)
	}
}

func TestUpload_Success_PNGImage(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "imguploader", 1)

	pngData := makePNGBytes(t, 16, 8)
	rr := doUpload(t, router, token, "file", "image.png", pngData)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["mime"] != "image/png" {
		t.Errorf("mime = %v, want image/png", resp["mime"])
	}
	// Image upload should include dimensions.
	if resp["width"] == nil {
		t.Error("expected width for image upload")
	}
	if resp["height"] == nil {
		t.Error("expected height for image upload")
	}
	if int(resp["width"].(float64)) != 16 {
		t.Errorf("width = %v, want 16", resp["width"])
	}
	if int(resp["height"].(float64)) != 8 {
		t.Errorf("height = %v, want 8", resp["height"])
	}
}

func TestUpload_Unauthenticated(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)

	rr := doUpload(t, router, "", "file", "test.txt", []byte("hello"))
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestUpload_InvalidToken(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)

	rr := doUpload(t, router, "invalid-token-123", "file", "test.txt", []byte("hello"))
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestUpload_MissingFileField(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "nofield", 1)

	// Upload with wrong field name "attachment" instead of "file".
	rr := doUpload(t, router, token, "attachment", "test.txt", []byte("hello world"))
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["message"] != "missing file field" {
		t.Errorf("message = %v, want 'missing file field'", resp["message"])
	}
}

func TestUpload_InvalidMultipartForm(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "badform", 1)

	// Send a request with Content-Type claiming multipart but with a plain body.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", bytes.NewReader([]byte("not multipart")))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=nonexistent")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_BlockedFileType_Executable(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "exeuploader", 1)

	// PE executable starts with "MZ".
	exeContent := append([]byte("MZ"), make([]byte, 100)...)
	rr := doUpload(t, router, token, "file", "malware.exe", exeContent)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	msg, _ := resp["message"].(string)
	if msg == "" {
		t.Error("expected non-empty error message for blocked file type")
	}
}

func TestUpload_BlockedFileType_ShellScript(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "shuploader", 1)

	// Shell script starts with "#!".
	shContent := []byte("#!/bin/bash\necho hello\n")
	rr := doUpload(t, router, token, "file", "script.sh", shContent)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_BlockedFileType_ELF(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "elfuploader", 1)

	// ELF binary starts with \x7fELF.
	elfContent := append([]byte("\x7fELF"), make([]byte, 100)...)
	rr := doUpload(t, router, token, "file", "binary", elfContent)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_RateLimitedAfterBurst(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	limiter := auth.NewRateLimiter()
	router := buildUploadRouterWithLimiter(database, store, limiter, nil)
	token := uploadCreateToken(t, database, "burstuser", 1)
	otherToken := uploadCreateToken(t, database, "otherburstuser", 1)
	content := []byte("upload payload with enough bytes for content type detection")

	for range 10 {
		rr := doUpload(t, router, token, "file", "burst.txt", content)
		if rr.Code != http.StatusCreated {
			t.Fatalf("pre-limit upload status = %d, want 201; body: %s", rr.Code, rr.Body.String())
		}
	}

	rr := doUpload(t, router, token, "file", "burst.txt", content)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited upload status = %d, want 429; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode rate-limit response: %v", err)
	}
	if resp["error"] != "RATE_LIMITED" {
		t.Errorf("error = %v, want RATE_LIMITED", resp["error"])
	}

	rr = doUpload(t, router, otherToken, "file", "burst.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("other user upload status = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_OversizedFileRejected(t *testing.T) {
	database := newUploadTestDB(t)
	dir := t.TempDir()
	store, err := storage.New(dir, 1)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "largeupload", 1)
	content := bytes.Repeat([]byte("a"), (1<<20)+1)

	rr := doUpload(t, router, token, "file", "too-large.txt", content)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("oversized upload status = %d, want 400; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode oversized response: %v", err)
	}
	message, _ := resp["message"].(string)
	if !strings.Contains(message, "file exceeds maximum size") {
		t.Fatalf("message = %q, want size rejection", message)
	}
	if resp["error"] != "BAD_REQUEST" {
		t.Errorf("error = %v, want BAD_REQUEST", resp["error"])
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

	// Remove the storage directory out from under the already-constructed
	// Storage so Save's os.Create fails — this is what a disk-full,
	// permission-change, or read-only-mount failure looks like from the
	// handler's point of view: a storage-layer error surfaces at Save time.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}

	content := []byte("content that will fail to persist because the storage dir is gone")
	rr := doUpload(t, router, token, "file", "leaktest.txt", content)
	// Server-side filesystem failures are 507 (storage.ErrIO) so they are
	// distinguishable from bad uploads; the no-leak contract is unchanged.
	if rr.Code != http.StatusInsufficientStorage {
		t.Fatalf("status = %d, want 507; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	message, _ := resp["message"].(string)
	if strings.Contains(message, dir) {
		t.Fatalf("response message leaks the absolute storage path: %q", message)
	}
	if strings.ContainsAny(message, `/\`) {
		t.Fatalf("response message looks like it contains a filesystem path: %q", message)
	}
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

	if _, err := database.ExecContext(context.Background(), `DROP TABLE attachments`); err != nil {
		t.Fatalf("drop attachments table: %v", err)
	}

	content := []byte("content that will save to disk before attachment insert fails")
	rr := doUpload(t, router, token, "file", "cleanup.txt", content)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("upload status = %d, want 500; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode db failure response: %v", err)
	}
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
	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
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
			if rr.Code != http.StatusCreated {
				t.Fatalf("status = %d, want 201; body: %s", rr.Code, rr.Body.String())
			}
			var resp map[string]any
			if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
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

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)

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

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

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

// ─── handleServeFile ────────────────────────────────────────────────────────

func TestServeFile_Success(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "serve1", 1)

	// Upload a file first.
	content := []byte("served file content with enough bytes for mime detection")
	rr := doUpload(t, router, token, "file", "served.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	fileID := uploadResp["id"].(string)

	// Serve the file (uploader is also the requester — allowed for unlinked files).
	rr2 := doServeFile(t, router, fileID, token, nil)
	if rr2.Code != http.StatusOK {
		t.Fatalf("serve status = %d, want 200; body: %s", rr2.Code, rr2.Body.String())
	}

	// Verify content type header is set.
	ct := rr2.Header().Get("Content-Type")
	if ct == "" {
		t.Error("expected Content-Type header on served file")
	}

	// Verify cache control header. Access-controlled downloads must be marked
	// private + no-cache so shared/proxy caches never store them (info-leak).
	cc := rr2.Header().Get("Cache-Control")
	if cc != "private, no-cache" {
		t.Errorf("Cache-Control = %q, want 'private, no-cache'", cc)
	}

	// Verify Content-Disposition header.
	cd := rr2.Header().Get("Content-Disposition")
	if cd == "" {
		t.Error("expected Content-Disposition header on served file")
	}
}

func TestServeFile_Success_PNG(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "servepng", 1)

	pngData := makePNGBytes(t, 4, 4)
	rr := doUpload(t, router, token, "file", "icon.png", pngData)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	fileID := uploadResp["id"].(string)

	rr2 := doServeFile(t, router, fileID, token, nil)
	if rr2.Code != http.StatusOK {
		t.Fatalf("serve status = %d, want 200", rr2.Code)
	}

	ct := rr2.Header().Get("Content-Type")
	if ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
}

func TestServeFile_NotFound(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "notfounduser", 1)

	rr := doServeFile(t, router, "nonexistent-uuid-12345", token, nil)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rr.Code)
	}
}

func TestServeFile_EmptyID(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)

	// Request to /api/v1/files/ with no ID should 404 (chi won't match the route).
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rr.Code)
	}
}

func TestServeFile_CORS_MatchingOrigin(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, []string{"https://app.example.com"})
	token := uploadCreateToken(t, database, "corsuser", 1)

	// Upload a file.
	content := []byte("cors test file content with sufficient length for detection")
	rr := doUpload(t, router, token, "file", "cors.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	fileID := uploadResp["id"].(string)

	// Serve with matching origin.
	rr2 := doServeFile(t, router, fileID, token, map[string]string{
		"Origin": "https://app.example.com",
	})
	if rr2.Code != http.StatusOK {
		t.Fatalf("serve status = %d, want 200", rr2.Code)
	}
	acao := rr2.Header().Get("Access-Control-Allow-Origin")
	if acao != "https://app.example.com" {
		t.Errorf("ACAO = %q, want https://app.example.com", acao)
	}
}

func TestServeFile_CORS_NonMatchingOrigin(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, []string{"https://app.example.com"})
	token := uploadCreateToken(t, database, "corsmismatch", 1)

	content := []byte("cors non-matching test file content with sufficient length")
	rr := doUpload(t, router, token, "file", "cors2.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d", rr.Code)
	}
	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	fileID := uploadResp["id"].(string)

	rr2 := doServeFile(t, router, fileID, token, map[string]string{
		"Origin": "https://evil.example.com",
	})
	if rr2.Code != http.StatusOK {
		t.Fatalf("serve status = %d, want 200", rr2.Code)
	}
	acao := rr2.Header().Get("Access-Control-Allow-Origin")
	if acao != "" {
		t.Errorf("ACAO should be empty for non-matching origin, got %q", acao)
	}
}

func TestServeFile_CORS_WildcardOrigin(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, []string{"*"})
	token := uploadCreateToken(t, database, "corswildcard", 1)

	content := []byte("wildcard cors test file content with sufficient length")
	rr := doUpload(t, router, token, "file", "wild.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d", rr.Code)
	}
	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	fileID := uploadResp["id"].(string)

	rr2 := doServeFile(t, router, fileID, token, map[string]string{
		"Origin": "https://anything.example.com",
	})
	if rr2.Code != http.StatusOK {
		t.Fatalf("serve status = %d, want 200", rr2.Code)
	}
	acao := rr2.Header().Get("Access-Control-Allow-Origin")
	if acao != "https://anything.example.com" {
		t.Errorf("ACAO = %q, want https://anything.example.com for wildcard", acao)
	}
}

func TestServeFile_CORS_NoOriginHeader(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, []string{"*"})
	token := uploadCreateToken(t, database, "corsnoorigin", 1)

	content := []byte("no origin header test file content with sufficient length")
	rr := doUpload(t, router, token, "file", "noorigin.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d", rr.Code)
	}
	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	fileID := uploadResp["id"].(string)

	// No Origin header — CORS headers should not be set.
	rr2 := doServeFile(t, router, fileID, token, nil)
	if rr2.Code != http.StatusOK {
		t.Fatalf("serve status = %d, want 200", rr2.Code)
	}
	acao := rr2.Header().Get("Access-Control-Allow-Origin")
	if acao != "" {
		t.Errorf("ACAO should be empty when no Origin sent, got %q", acao)
	}
}

func TestServeFile_DBRecordMissing_ReturnsNotFound(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "dbmissing", 1)

	// No file uploaded — DB has no record.
	rr := doServeFile(t, router, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", token, nil)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rr.Code)
	}
}

func TestServeFile_StorageFileMissing_ReturnsNotFound(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "storemissing", 1)

	// Upload a file, then delete it from storage.
	content := []byte("file that will be deleted from storage backend")
	rr := doUpload(t, router, token, "file", "vanish.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	fileID := uploadResp["id"].(string)

	// Delete the file from storage directly.
	if err := store.Delete(fileID); err != nil {
		t.Fatalf("store.Delete: %v", err)
	}

	// Serve should return 404 because the file is missing from disk.
	rr2 := doServeFile(t, router, fileID, token, nil)
	if rr2.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for missing storage file", rr2.Code)
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
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}

	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	fileID := uploadResp["id"].(string)
	url := uploadResp["url"].(string)

	// Serve using the URL from the upload response.
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusOK {
		t.Fatalf("serve status = %d, want 200", rr2.Code)
	}

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
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}

	var uploadResp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&uploadResp)
	url := uploadResp["url"].(string)

	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req)

	if rr2.Code != http.StatusOK {
		t.Fatalf("serve: %d", rr2.Code)
	}
	if rr2.Header().Get("Content-Type") != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", rr2.Header().Get("Content-Type"))
	}

	// Verify served bytes match original.
	if !bytes.Equal(rr2.Body.Bytes(), pngData) {
		t.Error("served PNG bytes differ from uploaded bytes")
	}
}

// ─── Access Control Tests (BUG-092) ────────────────────────────────────────

func TestServeFile_Unauthenticated_Returns401(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "acl401uploader", 1)

	// Upload a file.
	content := []byte("private file content for unauthenticated access test")
	rr := doUpload(t, router, token, "file", "private.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	// Request without auth token.
	rr2 := doServeFile(t, router, fileID, "", nil)
	if rr2.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 for unauthenticated file request", rr2.Code)
	}
}

func TestServeFile_UnlinkedFile_UploaderCanAccess(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "acluploader", 1)

	content := []byte("file owned by uploader for ownership access test")
	rr := doUpload(t, router, token, "file", "mine.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	// Uploader can access their own unlinked file.
	rr2 := doServeFile(t, router, fileID, token, nil)
	if rr2.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 for uploader accessing own file", rr2.Code)
	}
}

func TestServeFile_UnlinkedFile_OtherUserForbidden(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	uploaderToken := uploadCreateToken(t, database, "aclowner", 4) // Member role
	otherToken := uploadCreateToken(t, database, "aclother", 4)    // Member role

	content := []byte("private file content for other-user forbidden test")
	rr := doUpload(t, router, uploaderToken, "file", "secret.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	// Other user cannot access unlinked file.
	rr2 := doServeFile(t, router, fileID, otherToken, nil)
	if rr2.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 for other user accessing unlinked file", rr2.Code)
	}
}

func TestServeFile_AdminCannotReadAnotherUsersUnlinkedFile(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	uploaderToken := uploadCreateToken(t, database, "acluploaderadmin", 4) // Member
	adminToken := uploadCreateToken(t, database, "acladmin", 1)            // Owner (admin)

	content := []byte("file for admin unlinked test content with sufficient bytes")
	rr := doUpload(t, router, uploaderToken, "file", "restricted.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	rr2 := doServeFile(t, router, fileID, adminToken, nil)
	if rr2.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 for admin reading another user's unlinked file", rr2.Code)
	}
}

func TestServeFile_LinkedToGuildChannel_MemberWithPerm(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "guildmember", 4) // Member role (perms=1635, includes ReadMessages=0x0002)

	// Upload a file.
	content := []byte("guild channel attachment content for permission test")
	rr := doUpload(t, router, token, "file", "guild.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	// Create a guild channel and link the attachment via a message.
	_, err := database.ExecContext(context.Background(), `INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`)
	if err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	// Get the uploader's user ID.
	var userID int64
	if err := database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'guildmember'`).Scan(&userID); err != nil {
		t.Fatalf("get user id: %v", err)
	}
	_, err = database.ExecContext(context.Background(), `INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, ?, 'test')`, userID)
	if err != nil {
		t.Fatalf("insert message: %v", err)
	}
	_, err = database.ExecContext(context.Background(), `UPDATE attachments SET message_id = 1 WHERE id = ?`, fileID)
	if err != nil {
		t.Fatalf("link attachment: %v", err)
	}

	// Member with ReadMessages should be able to access.
	rr2 := doServeFile(t, router, fileID, token, nil)
	if rr2.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 for guild member with READ_MESSAGES", rr2.Code)
	}
}

func TestServeFile_LinkedToGuildChannel_MemberWithoutPerm(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	uploaderToken := uploadCreateToken(t, database, "guilduploader2", 1) // Owner (to upload)
	memberToken := uploadCreateToken(t, database, "guildnoperm", 4)      // Member

	// Upload a file.
	content := []byte("guild channel attachment content for denied permission test")
	rr := doUpload(t, router, uploaderToken, "file", "restricted.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	// Create channel and link.
	_, err := database.ExecContext(context.Background(), `INSERT INTO channels (id, name, type) VALUES (1, 'secret', 'text')`)
	if err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	var uploaderID int64
	if err := database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'guilduploader2'`).Scan(&uploaderID); err != nil {
		t.Fatalf("get user id: %v", err)
	}
	_, err = database.ExecContext(context.Background(), `INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, ?, 'test')`, uploaderID)
	if err != nil {
		t.Fatalf("insert message: %v", err)
	}
	_, err = database.ExecContext(context.Background(), `UPDATE attachments SET message_id = 1 WHERE id = ?`, fileID)
	if err != nil {
		t.Fatalf("link attachment: %v", err)
	}
	// Deny ReadMessages (0x0002) for role 4 (Member) on channel 1.
	_, err = database.ExecContext(context.Background(), `INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (1, 4, 0, 2)`)
	if err != nil {
		t.Fatalf("insert channel_override: %v", err)
	}

	// Member without ReadMessages should get 403.
	rr2 := doServeFile(t, router, fileID, memberToken, nil)
	if rr2.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 for guild member without READ_MESSAGES", rr2.Code)
	}
}

func TestServeFile_LinkedToDM_ParticipantAllowed(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token1 := uploadCreateToken(t, database, "dmalice", 4)
	_ = uploadCreateToken(t, database, "dmbob", 4)

	// Upload a file.
	content := []byte("dm attachment content for participant access test")
	rr := doUpload(t, router, token1, "file", "dm.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	// Create DM channel, add participants, link attachment.
	_, err := database.ExecContext(context.Background(), `INSERT INTO channels (id, name, type) VALUES (1, 'dm-1', 'dm')`)
	if err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	var aliceID, bobID int64
	_ = database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'dmalice'`).Scan(&aliceID)
	_ = database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'dmbob'`).Scan(&bobID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO dm_participants (user_id, channel_id) VALUES (?, 1)`, aliceID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO dm_participants (user_id, channel_id) VALUES (?, 1)`, bobID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, ?, 'hi')`, aliceID)
	_, _ = database.ExecContext(context.Background(), `UPDATE attachments SET message_id = 1 WHERE id = ?`, fileID)

	// DM participant can access.
	rr2 := doServeFile(t, router, fileID, token1, nil)
	if rr2.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 for DM participant", rr2.Code)
	}
}

func TestServeFile_LinkedToDM_NonParticipantForbidden(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token1 := uploadCreateToken(t, database, "dmowner", 4)
	_ = uploadCreateToken(t, database, "dmpartner", 4)
	outsiderToken := uploadCreateToken(t, database, "dmoutsider", 4)

	// Upload a file.
	content := []byte("dm attachment content for non-participant forbidden test")
	rr := doUpload(t, router, token1, "file", "dmsecret.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	// Create DM channel with two participants (not the outsider).
	_, err := database.ExecContext(context.Background(), `INSERT INTO channels (id, name, type) VALUES (1, 'dm-1', 'dm')`)
	if err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	var ownerID, partnerID int64
	_ = database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'dmowner'`).Scan(&ownerID)
	_ = database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'dmpartner'`).Scan(&partnerID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO dm_participants (user_id, channel_id) VALUES (?, 1)`, ownerID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO dm_participants (user_id, channel_id) VALUES (?, 1)`, partnerID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, ?, 'hi')`, ownerID)
	_, _ = database.ExecContext(context.Background(), `UPDATE attachments SET message_id = 1 WHERE id = ?`, fileID)

	// Non-participant gets 403.
	rr2 := doServeFile(t, router, fileID, outsiderToken, nil)
	if rr2.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 for DM non-participant", rr2.Code)
	}
}

// OC-0112: the admin bypass in handleServeFile must not cover the DM
// participant check. Every sibling DM read gate (requireChannelRead,
// checkSendPermission) denies a non-participant Administrator just like
// anyone else — the file route must match, not open every private DM to
// anyone holding the admin bit.
func TestServeFile_LinkedToDM_AdminNonParticipantForbidden(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token1 := uploadCreateToken(t, database, "dmadminowner", 4)
	_ = uploadCreateToken(t, database, "dmadminpartner", 4)
	adminToken := uploadCreateToken(t, database, "dmadminoutsider", 1) // Owner (admin), not a participant

	// Upload a file.
	content := []byte("dm attachment content for admin non-participant forbidden test")
	rr := doUpload(t, router, token1, "file", "dmadminsecret.txt", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	fileID := resp["id"].(string)

	// Create DM channel with two participants (not the admin).
	_, err := database.ExecContext(context.Background(), `INSERT INTO channels (id, name, type) VALUES (1, 'dm-1', 'dm')`)
	if err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	var ownerID, partnerID int64
	_ = database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'dmadminowner'`).Scan(&ownerID)
	_ = database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'dmadminpartner'`).Scan(&partnerID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO dm_participants (user_id, channel_id) VALUES (?, 1)`, ownerID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO dm_participants (user_id, channel_id) VALUES (?, 1)`, partnerID)
	_, _ = database.ExecContext(context.Background(), `INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, ?, 'hi')`, ownerID)
	_, _ = database.ExecContext(context.Background(), `UPDATE attachments SET message_id = 1 WHERE id = ?`, fileID)

	// Admin who is not a DM participant must still be denied.
	rr2 := doServeFile(t, router, fileID, adminToken, nil)
	if rr2.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 for admin who is not a DM participant", rr2.Code)
	}
}

// ─── GET /api/v1/files/{id}/thumb (P4-08) ───────────────────────────────────

func doServeThumb(t *testing.T, router http.Handler, fileID, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/"+fileID+"/thumb", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
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
	if rr.Code != http.StatusOK {
		t.Fatalf("thumb: %d; body: %s", rr.Code, rr.Body.String())
	}
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

// A JPEG's decode is counted at three times its decoded image, for the
// coefficient blocks a progressive decode holds: this 20-megapixel greyscale
// JPEG, small on disk, is under the cap counted as a plain image but over it
// counted as a JPEG, and is passed through without a decode.
func TestServeThumb_LargeJPEGIsNotDecoded(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbbigjpg", 4)
	content := encodeJPEG(t, image.NewGray(image.Rect(0, 0, 5000, 4000)))
	id := uploadForThumb(t, router, token, "wide.jpg", content)

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), content) {
		t.Errorf("large JPEG: %d, %d bytes; want the original passed through", rr.Code, rr.Body.Len())
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a thumbnail was made of the large JPEG: %v", err)
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
