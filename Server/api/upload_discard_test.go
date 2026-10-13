package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// DELETE /api/v1/uploads/{id}: the uploader withdraws a file it staged and
// never sent, and its quota is free at once rather than at the orphan sweep.

func doDiscard(t *testing.T, router http.Handler, token, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/uploads/"+id, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func uploadedID(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rr.Code, rr.Body.String())
	}
	var resp struct{ ID string }
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("upload body: %v", err)
	}
	return resp.ID
}

func TestDiscardUpload_FreesQuotaForTheNextUpload(t *testing.T) {
	h := newQuotaHarness(t, nil)
	envelopeBody, _ := makeMultipartFile(t, "file", "a.bin", bytes.Repeat([]byte("x"), 1024))
	h.limits(t, int64(envelopeBody.Len()), 0, nil)
	first := uploadedID(t, doUpload(t, h.router, h.token, "file", "a.bin", bytes.Repeat([]byte("x"), 1024)))

	rr := doUpload(t, h.router, h.token, "file", "a.bin", bytes.Repeat([]byte("x"), 1024))
	assertErrorCode(t, rr, http.StatusInsufficientStorage, "STORAGE_QUOTA_EXCEEDED")

	rr = doDiscard(t, h.router, h.token, first)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("discard: %d %s", rr.Code, rr.Body.String())
	}
	if got := h.used(t); got != 0 {
		t.Fatalf("counter = %d after discard, want 0", got)
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("the discarded file is still on disk")
	}
	uploadedID(t, doUpload(t, h.router, h.token, "file", "a.bin", bytes.Repeat([]byte("x"), 1024)))

	if rr := doDiscard(t, h.router, h.token, first); rr.Code != http.StatusNotFound {
		t.Fatalf("second discard: %d, want 404", rr.Code)
	}
}

func TestDiscardUpload_LeavesFilesItMayNotRemove(t *testing.T) {
	h := newQuotaHarness(t, nil)
	ctx := context.Background()
	other := uploadCreateToken(t, h.database, "discard_other", int(permissions.MemberRoleID))
	foreign := uploadedID(t, doUpload(t, h.router, other, "file", "theirs.txt", []byte("theirs")))
	sent := uploadedID(t, doUpload(t, h.router, h.token, "file", "sent.txt", []byte("sent")))
	avatar := uploadedID(t, doUpload(t, h.router, h.token, "file", "avatar.txt", []byte("avatar")))

	if _, err := h.database.ExecContext(ctx, `INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	if _, err := h.database.ExecContext(ctx, `INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, ?, 'hi')`, h.userID); err != nil {
		t.Fatalf("insert message: %v", err)
	}
	if _, err := h.database.ExecContext(ctx, `UPDATE attachments SET message_id = 1 WHERE id = ?`, sent); err != nil {
		t.Fatalf("link attachment: %v", err)
	}
	if _, err := h.database.ExecContext(ctx, `UPDATE users SET avatar = ? WHERE id = ?`, "/api/v1/files/"+avatar, h.userID); err != nil {
		t.Fatalf("set avatar: %v", err)
	}
	legacy := uploadedID(t, doUpload(t, h.router, h.token, "file", "legacy.txt", []byte("legacy")))
	if _, err := h.database.ExecContext(ctx, `UPDATE attachments SET uploader_id = NULL WHERE id = ?`, legacy); err != nil {
		t.Fatalf("clear uploader: %v", err)
	}

	for name, id := range map[string]string{"another user's": foreign, "a sent": sent, "a live avatar": avatar, "a legacy unowned": legacy, "an unknown": "no-such-id"} {
		t.Run(name, func(t *testing.T) {
			assertErrorCode(t, doDiscard(t, h.router, h.token, id), http.StatusNotFound, "NOT_FOUND")
		})
	}
	if got := h.filesOnDisk(t); got != 4 {
		t.Fatalf("files on disk = %d, want all 4 kept", got)
	}
	var rows int
	if err := h.database.QueryRowContext(ctx, `SELECT COUNT(*) FROM attachments`).Scan(&rows); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if rows != 4 {
		t.Fatalf("attachment rows = %d, want all 4 kept", rows)
	}
}

func TestDiscardUpload_RequiresAuth(t *testing.T) {
	h := newQuotaHarness(t, nil)
	id := uploadedID(t, doUpload(t, h.router, h.token, "file", "a.txt", []byte("a")))
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/uploads/"+id, nil)
	rr := httptest.NewRecorder()
	h.router.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
	if h.filesOnDisk(t) != 1 {
		t.Fatal("an unauthenticated discard removed the file")
	}
}
