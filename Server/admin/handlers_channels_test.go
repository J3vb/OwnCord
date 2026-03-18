package admin_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/owncord/server/admin"
)

// ─── Category-Type Validation (via POST /channels) ──────────────────────────

func TestCreateChannel_TextUnderTextCategory_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"name":     "general",
		"type":     "text",
		"category": "Chat",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
	if w.Code != http.StatusCreated {
		t.Errorf("text channel under Chat: status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
}

func TestCreateChannel_AnnouncementUnderTextCategory_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"name":     "announcements",
		"type":     "announcement",
		"category": "Text Channels",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
	if w.Code != http.StatusCreated {
		t.Errorf("announcement under Text Channels: status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
}

func TestCreateChannel_VoiceUnderVoiceCategory_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"name":     "lounge",
		"type":     "voice",
		"category": "Voice Channels",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
	if w.Code != http.StatusCreated {
		t.Errorf("voice under Voice Channels: status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
}

func TestCreateChannel_VoiceUnderTextCategory_Rejected(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"name":     "bad-voice",
		"type":     "voice",
		"category": "Chat",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
	if w.Code != http.StatusBadRequest {
		t.Errorf("voice under Chat: status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err == nil {
		if resp["error"] != "INVALID_INPUT" {
			t.Errorf("error code = %q, want INVALID_INPUT", resp["error"])
		}
	}
}

func TestCreateChannel_TextUnderVoiceCategory_Rejected(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"name":     "bad-text",
		"type":     "text",
		"category": "Voice Channels",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
	if w.Code != http.StatusBadRequest {
		t.Errorf("text under Voice Channels: status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

func TestCreateChannel_EmptyCategory_Allowed(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	body := map[string]any{
		"name":     "uncategorized",
		"type":     "voice",
		"category": "",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
	if w.Code != http.StatusCreated {
		t.Errorf("voice with empty category: status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
}

func TestCreateChannel_CaseInsensitiveVoiceCategory(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil)
	token := createAdminUser(t, database)

	// "VOICE" in uppercase should still be treated as a voice category
	body := map[string]any{
		"name":     "vc",
		"type":     "voice",
		"category": "VOICE CHANNELS",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)
	if w.Code != http.StatusCreated {
		t.Errorf("voice under VOICE CHANNELS: status = %d, want 201; body: %s", w.Code, w.Body.String())
	}

	// Text under uppercase VOICE should be rejected
	body2 := map[string]any{
		"name":     "bad",
		"type":     "text",
		"category": "VOICE CHANNELS",
	}
	w2 := doRequest(t, handler, http.MethodPost, "/channels", token, body2)
	if w2.Code != http.StatusBadRequest {
		t.Errorf("text under VOICE CHANNELS: status = %d, want 400; body: %s", w2.Code, w2.Body.String())
	}
}
