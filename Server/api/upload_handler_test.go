package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/storage"
)

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
    ban_expires TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER
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
	api.MountUploadRoutes(r, database, store, allowedOrigins)
	return r
}

// uploadCreateToken creates a user+session and returns the plaintext token.
func uploadCreateToken(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	_, err := database.CreateUser(username, "$2a$12$fake", roleID)
	if err != nil {
		t.Fatalf("CreateUser %q: %v", username, err)
	}
	token := "upload-test-token-" + username
	hash := auth.HashToken(token)
	_, err = database.Exec(
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

func doServeFile(t *testing.T, router http.Handler, fileID string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/"+fileID, nil)
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

	// GET /api/v1/files/{id} should not return 405 (404 is valid for missing file).
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
	att, err := database.GetAttachmentByID(resp["id"].(string))
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
	att, err := database.GetAttachmentByID(fileID)
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

	// Serve the file (no auth required).
	rr2 := doServeFile(t, router, fileID, nil)
	if rr2.Code != http.StatusOK {
		t.Fatalf("serve status = %d, want 200; body: %s", rr2.Code, rr2.Body.String())
	}

	// Verify content type header is set.
	ct := rr2.Header().Get("Content-Type")
	if ct == "" {
		t.Error("expected Content-Type header on served file")
	}

	// Verify cache control header.
	cc := rr2.Header().Get("Cache-Control")
	if cc != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control = %q, want 'public, max-age=31536000, immutable'", cc)
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

	rr2 := doServeFile(t, router, fileID, nil)
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

	rr := doServeFile(t, router, "nonexistent-uuid-12345", nil)
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
	rr2 := doServeFile(t, router, fileID, map[string]string{
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

	rr2 := doServeFile(t, router, fileID, map[string]string{
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

	rr2 := doServeFile(t, router, fileID, map[string]string{
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
	rr2 := doServeFile(t, router, fileID, nil)
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

	// No file uploaded — DB has no record.
	rr := doServeFile(t, router, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", nil)
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
	rr2 := doServeFile(t, router, fileID, nil)
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
