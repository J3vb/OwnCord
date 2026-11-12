package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ─── handleServeFile ────────────────────────────────────────────────────────

func TestServeFile_Success(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "serve1", 1)

	// Upload a file first.
	content := []byte("served file content with enough bytes for mime detection")
	rr := doUpload(t, router, token, "file", "served.txt", content)
	requireStatus(t, rr, http.StatusCreated)

	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)

	// Serve the file (uploader is also the requester — allowed for unlinked files).
	rr2 := doServeFile(t, router, fileID, token, nil)
	requireStatus(t, rr2, http.StatusOK)

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
	requireStatus(t, rr, http.StatusCreated)

	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)

	rr2 := doServeFile(t, router, fileID, token, nil)
	requireStatus(t, rr2, http.StatusOK)

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
	expectStatus(t, rr, http.StatusNotFound)
}

func TestServeFile_EmptyID(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)

	// Request to /api/v1/files/ with no ID should 404 (chi won't match the route).
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/", nil)
	rr := serveLocal(router, req)

	expectStatus(t, rr, http.StatusNotFound)
}

func TestServeFile_CORS_MatchingOrigin(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, []string{"https://app.example.com"})
	token := uploadCreateToken(t, database, "corsuser", 1)

	// Upload a file.
	content := []byte("cors test file content with sufficient length for detection")
	rr := doUpload(t, router, token, "file", "cors.txt", content)
	requireStatus(t, rr, http.StatusCreated)
	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)

	// Serve with matching origin.
	rr2 := doServeFile(t, router, fileID, token, map[string]string{
		"Origin": "https://app.example.com",
	})
	requireStatus(t, rr2, http.StatusOK)
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
	requireStatus(t, rr, http.StatusCreated)
	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)

	rr2 := doServeFile(t, router, fileID, token, map[string]string{
		"Origin": "https://evil.example.com",
	})
	requireStatus(t, rr2, http.StatusOK)
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
	requireStatus(t, rr, http.StatusCreated)
	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)

	rr2 := doServeFile(t, router, fileID, token, map[string]string{
		"Origin": "https://anything.example.com",
	})
	requireStatus(t, rr2, http.StatusOK)
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
	requireStatus(t, rr, http.StatusCreated)
	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)

	// No Origin header — CORS headers should not be set.
	rr2 := doServeFile(t, router, fileID, token, nil)
	requireStatus(t, rr2, http.StatusOK)
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
	expectStatus(t, rr, http.StatusNotFound)
}

func TestServeFile_StorageFileMissing_ReturnsNotFound(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "storemissing", 1)

	// Upload a file, then delete it from storage.
	content := []byte("file that will be deleted from storage backend")
	rr := doUpload(t, router, token, "file", "vanish.txt", content)
	requireStatus(t, rr, http.StatusCreated)
	uploadResp := decodeBody[map[string]any](t, rr)
	fileID := uploadResp["id"].(string)

	// Delete the file from storage directly.
	if err := store.Delete(fileID); err != nil {
		t.Fatalf("store.Delete: %v", err)
	}

	// Serve should return 404 because the file is missing from disk.
	rr2 := doServeFile(t, router, fileID, token, nil)
	expectStatus(t, rr2, http.StatusNotFound)
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
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
	fileID := resp["id"].(string)

	// Request without auth token.
	rr2 := doServeFile(t, router, fileID, "", nil)
	expectStatus(t, rr2, http.StatusUnauthorized)
}

func TestServeFile_UnlinkedFile_UploaderCanAccess(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "acluploader", 1)

	content := []byte("file owned by uploader for ownership access test")
	rr := doUpload(t, router, token, "file", "mine.txt", content)
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
	fileID := resp["id"].(string)

	// Uploader can access their own unlinked file.
	rr2 := doServeFile(t, router, fileID, token, nil)
	expectStatus(t, rr2, http.StatusOK)
}

func TestServeFile_UnlinkedFile_OtherUserForbidden(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	uploaderToken := uploadCreateToken(t, database, "aclowner", 4) // Member role
	otherToken := uploadCreateToken(t, database, "aclother", 4)    // Member role

	content := []byte("private file content for other-user forbidden test")
	rr := doUpload(t, router, uploaderToken, "file", "secret.txt", content)
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
	fileID := resp["id"].(string)

	// Other user cannot access unlinked file.
	rr2 := doServeFile(t, router, fileID, otherToken, nil)
	expectStatus(t, rr2, http.StatusForbidden)
}

func TestServeFile_AdminCannotReadAnotherUsersUnlinkedFile(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	uploaderToken := uploadCreateToken(t, database, "acluploaderadmin", 4) // Member
	adminToken := uploadCreateToken(t, database, "acladmin", 1)            // Owner (admin)

	content := []byte("file for admin unlinked test content with sufficient bytes")
	rr := doUpload(t, router, uploaderToken, "file", "restricted.txt", content)
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
	fileID := resp["id"].(string)

	rr2 := doServeFile(t, router, fileID, adminToken, nil)
	expectStatus(t, rr2, http.StatusForbidden)
}

func TestServeFile_LinkedToGuildChannel_MemberWithPerm(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "guildmember", 4) // Member role (perms=1635, includes ReadMessages=0x0002)

	// Upload a file.
	content := []byte("guild channel attachment content for permission test")
	rr := doUpload(t, router, token, "file", "guild.txt", content)
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
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
	expectStatus(t, rr2, http.StatusOK)
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
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
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
	expectStatus(t, rr2, http.StatusForbidden)
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
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
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
	expectStatus(t, rr2, http.StatusOK)
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
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
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
	expectStatus(t, rr2, http.StatusForbidden)
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
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
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
	expectStatus(t, rr2, http.StatusForbidden)
}
