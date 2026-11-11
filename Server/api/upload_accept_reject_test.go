package api_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/storage"
)

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
	rr := serveLocal(router, req)
	if rr.Code == http.StatusNotFound || rr.Code == http.StatusMethodNotAllowed {
		t.Errorf("POST /api/v1/uploads returned %d, route not mounted", rr.Code)
	}

	// GET /api/v1/files/{id} should not return 405 (401 or 404 are valid).
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/files/some-id", nil)
	req2.RemoteAddr = "127.0.0.1:9999"
	rr2 := serveRequest(router, req2)
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

	requireStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
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

	requireStatus(t, rr, http.StatusCreated)

	resp := decodeBody[map[string]any](t, rr)
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
	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestUpload_InvalidToken(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)

	rr := doUpload(t, router, "invalid-token-123", "file", "test.txt", []byte("hello"))
	expectStatus(t, rr, http.StatusUnauthorized)
}

func TestUpload_MissingFileField(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "nofield", 1)

	// Upload with wrong field name "attachment" instead of "file".
	rr := doUpload(t, router, token, "attachment", "test.txt", []byte("hello world"))
	expectStatus(t, rr, http.StatusBadRequest)

	resp := decodeBody[map[string]any](t, rr)
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
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusBadRequest)
}

func TestUpload_BlockedFileType_Executable(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "exeuploader", 1)

	// PE executable starts with "MZ".
	exeContent := append([]byte("MZ"), make([]byte, 100)...)
	rr := doUpload(t, router, token, "file", "malware.exe", exeContent)

	expectStatus(t, rr, http.StatusBadRequest)

	resp := decodeBody[map[string]any](t, rr)
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

	expectStatus(t, rr, http.StatusBadRequest)
}

func TestUpload_BlockedFileType_ELF(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "elfuploader", 1)

	// ELF binary starts with \x7fELF.
	elfContent := append([]byte("\x7fELF"), make([]byte, 100)...)
	rr := doUpload(t, router, token, "file", "binary", elfContent)

	expectStatus(t, rr, http.StatusBadRequest)
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
		requireStatus(t, rr, http.StatusCreated)
	}

	rr := doUpload(t, router, token, "file", "burst.txt", content)
	requireStatus(t, rr, http.StatusTooManyRequests)

	resp := decodeBody[map[string]any](t, rr)
	if resp["error"] != "RATE_LIMITED" {
		t.Errorf("error = %v, want RATE_LIMITED", resp["error"])
	}

	rr = doUpload(t, router, otherToken, "file", "burst.txt", content)
	requireStatus(t, rr, http.StatusCreated)
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
	requireStatus(t, rr, http.StatusBadRequest)

	resp := decodeBody[map[string]any](t, rr)
	message, _ := resp["message"].(string)
	if !strings.Contains(message, "file exceeds maximum size") {
		t.Fatalf("message = %q, want size rejection", message)
	}
	if resp["error"] != "BAD_REQUEST" {
		t.Errorf("error = %v, want BAD_REQUEST", resp["error"])
	}
}
