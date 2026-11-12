package api_test

import (
	"context"
	"net/http"
	"testing"
)

// A soft-deleted message's linked attachment must stop being servable — the
// client shows a tombstone, but the file stayed reachable by URL forever
// with no way to reclaim it (v034).
func TestServeFile_LinkedToDeletedMessage_NotFound(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "deletedmsgowner", 4) // Member role

	content := []byte("attachment content for a message that will be soft-deleted")
	rr := doUpload(t, router, token, "file", "willbedeleted.txt", content)
	requireStatus(t, rr, http.StatusCreated)
	resp := decodeBody[map[string]any](t, rr)
	fileID := resp["id"].(string)

	if _, err := database.ExecContext(context.Background(), `INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	var userID int64
	if err := database.QueryRowContext(context.Background(), `SELECT id FROM users WHERE username = 'deletedmsgowner'`).Scan(&userID); err != nil {
		t.Fatalf("get user id: %v", err)
	}
	if _, err := database.ExecContext(context.Background(), `INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, ?, 'test')`, userID); err != nil {
		t.Fatalf("insert message: %v", err)
	}
	if _, err := database.ExecContext(context.Background(), `UPDATE attachments SET message_id = 1 WHERE id = ?`, fileID); err != nil {
		t.Fatalf("link attachment: %v", err)
	}

	// Sanity: readable before the message is deleted.
	rr2 := doServeFile(t, router, fileID, token, nil)
	requireStatus(t, rr2, http.StatusOK)

	if _, err := database.ExecContext(context.Background(), `UPDATE messages SET deleted = 1 WHERE id = 1`); err != nil {
		t.Fatalf("soft-delete message: %v", err)
	}

	rr3 := doServeFile(t, router, fileID, token, nil)
	expectStatus(t, rr3, http.StatusNotFound)
}
