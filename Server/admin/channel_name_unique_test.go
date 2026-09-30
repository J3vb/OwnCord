package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// createChannelID creates a channel through the API and returns its id.
func createChannelID(t *testing.T, handler http.Handler, token, name, chType, category string) int64 {
	t.Helper()
	w := doRequest(t, handler, http.MethodPost, "/channels", token,
		map[string]any{"name": name, "type": chType, "category": category})
	if w.Code != http.StatusCreated {
		t.Fatalf("create %q = %d, want 201; body: %s", name, w.Code, w.Body.String())
	}
	var ch struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &ch); err != nil || ch.ID == 0 {
		t.Fatalf("create %q: no id in %s", name, w.Body.String())
	}
	return ch.ID
}

// TestCreateChannel_DuplicateNameConflicts: a name already used by a channel
// of the same type in the same category is refused with 409, whatever its
// case; another type or another category may reuse it.
func TestCreateChannel_DuplicateNameConflicts(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)
	createChannelID(t, handler, token, "General", "text", "Chat")

	w := doRequest(t, handler, http.MethodPost, "/channels", token,
		map[string]any{"name": "general", "type": "text", "category": "Chat"})
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate create = %d, want 409; body: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !strings.Contains(resp.Message, "already exists") {
		t.Errorf("message = %q, want it to say the name already exists", resp.Message)
	}

	createChannelID(t, handler, token, "general", "voice", "Chat")
	createChannelID(t, handler, token, "general", "text", "Other")
	createChannelID(t, handler, token, "general", "text", "")
}

// TestPatchChannel_RenameToDuplicateConflicts: renaming onto a sibling's name
// is refused; a case-only rename of the channel itself is not.
func TestPatchChannel_RenameToDuplicateConflicts(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)
	createChannelID(t, handler, token, "general", "text", "Chat")
	other := createChannelID(t, handler, token, "random", "text", "Chat")

	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(other), token, map[string]any{"name": "GENERAL"})
	if w.Code != http.StatusConflict {
		t.Fatalf("rename onto a sibling = %d, want 409; body: %s", w.Code, w.Body.String())
	}
	w = doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(other), token, map[string]any{"category": "Other", "name": "general"})
	if w.Code != http.StatusOK {
		t.Errorf("rename into another category = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	w = doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(other), token, map[string]any{"name": "General"})
	if w.Code != http.StatusOK {
		t.Errorf("case-only rename of itself = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

// TestPatchChannel_ExistingDuplicatesStayEditable: rows that already share a
// name are left alone, and an edit that does not touch the name or category
// still saves.
func TestPatchChannel_ExistingDuplicatesStayEditable(t *testing.T) {
	handler, token, database := newChannelTestAPI(t)
	ctx := context.Background()
	if _, err := database.CreateChannel(ctx, "dup", "text", "Chat", "", 0); err != nil {
		t.Fatal(err)
	}
	second, err := database.CreateChannel(ctx, "dup", "text", "Chat", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(second), token, map[string]any{"topic": "still editable"})
	if w.Code != http.StatusOK {
		t.Errorf("topic edit on a pre-existing duplicate = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}
