package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
)

// patchSetting sends one key through PATCH /settings as the Owner and returns
// the response and the database, so a refusal can be checked for a write.
func patchSetting(t *testing.T, key, value string) (int, string, string, *db.DB) {
	t.Helper()
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, map[string]string{key: value})
	var resp struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if w.Code == http.StatusBadRequest && resp.Error != "BAD_REQUEST" {
		t.Errorf("%s=%q: error code = %q, want BAD_REQUEST like every other invalid setting", key, value, resp.Error)
	}
	return w.Code, resp.Message, w.Body.String(), database
}

// storedSetting reads a setting back; a key never written reads as "<unset>",
// so a refused empty value is not mistaken for a stored one.
func storedSetting(t *testing.T, database *db.DB, key string) string {
	t.Helper()
	v, err := database.GetSetting(context.Background(), key)
	if err != nil {
		return "<unset>"
	}
	return v
}

// TestPatchSettings_MaxUploadBytes: only a whole number of bytes inside the
// setup wizard's upload bounds (1 MB to 10240 MB) is stored.
func TestPatchSettings_MaxUploadBytes(t *testing.T) {
	for _, bad := range []string{"-5", "abc", "0", "1.5", "", "1048575", "10737418241", "99999999999999999999"} {
		code, msg, body, database := patchSetting(t, "max_upload_bytes", bad)
		if code != http.StatusBadRequest {
			t.Errorf("max_upload_bytes=%q = %d, want 400; body: %s", bad, code, body)
			continue
		}
		if !strings.HasPrefix(msg, "max_upload_bytes") {
			t.Errorf("max_upload_bytes=%q: message = %q, want it to name the key", bad, msg)
		}
		if got := storedSetting(t, database, "max_upload_bytes"); got == bad {
			t.Errorf("max_upload_bytes=%q was stored despite the 400", bad)
		}
	}
	for _, tc := range []struct{ value, want string }{
		{"1048576", "1048576"},
		{"104857600", "104857600"},
		{" 5242880 ", "5242880"},
		{"10737418240", "10737418240"},
	} {
		value, want := tc.value, tc.want
		code, _, body, database := patchSetting(t, "max_upload_bytes", value)
		if code != http.StatusOK {
			t.Errorf("max_upload_bytes=%q = %d, want 200; body: %s", value, code, body)
			continue
		}
		if got := storedSetting(t, database, "max_upload_bytes"); got != want {
			t.Errorf("max_upload_bytes=%q stored %q, want %q", value, got, want)
		}
	}
}

// TestPatchSettings_VoiceQuality: only a preset the voice code accepts is
// stored, normalised to lower case like the setup wizard does.
func TestPatchSettings_VoiceQuality(t *testing.T) {
	for _, bad := range []string{"ultra", "", "best", "medium-high"} {
		code, msg, body, database := patchSetting(t, "voice_quality", bad)
		if code != http.StatusBadRequest {
			t.Errorf("voice_quality=%q = %d, want 400; body: %s", bad, code, body)
			continue
		}
		if msg != "voice_quality must be one of: low, medium, high" {
			t.Errorf("voice_quality=%q: message = %q", bad, msg)
		}
		if got := storedSetting(t, database, "voice_quality"); got == bad {
			t.Errorf("voice_quality=%q was stored despite the 400", bad)
		}
	}
	for _, tc := range []struct{ value, want string }{{"low", "low"}, {"medium", "medium"}, {" HIGH ", "high"}} {
		value, want := tc.value, tc.want
		code, _, body, database := patchSetting(t, "voice_quality", value)
		if code != http.StatusOK {
			t.Errorf("voice_quality=%q = %d, want 200; body: %s", value, code, body)
			continue
		}
		if got := storedSetting(t, database, "voice_quality"); got != want {
			t.Errorf("voice_quality=%q stored %q, want %q", value, got, want)
		}
	}
}

// TestPatchSettings_IdentityLengthLimits: the settings page enforces the same
// server_name and motd limits as the setup wizard.
func TestPatchSettings_IdentityLengthLimits(t *testing.T) {
	cases := []struct {
		key, value string
		want       int
		msg        string
	}{
		{"server_name", strings.Repeat("n", 100), http.StatusOK, ""},
		{"server_name", strings.Repeat("n", 101), http.StatusBadRequest, "server_name must be at most 100 characters"},
		{"server_name", strings.Repeat("n", 600), http.StatusBadRequest, "server_name must be at most 100 characters"},
		{"server_name", "   ", http.StatusBadRequest, "server_name cannot be empty"},
		{"motd", strings.Repeat("m", 500), http.StatusOK, ""},
		{"motd", strings.Repeat("m", 501), http.StatusBadRequest, "motd must be at most 500 characters"},
		{"motd", "", http.StatusOK, ""},
	}
	for _, tc := range cases {
		code, msg, body, database := patchSetting(t, tc.key, tc.value)
		if code != tc.want {
			t.Errorf("%s (%d chars) = %d, want %d; body: %s", tc.key, len(tc.value), code, tc.want, body)
			continue
		}
		if tc.want == http.StatusOK {
			if got := storedSetting(t, database, tc.key); got != strings.TrimSpace(tc.value) {
				t.Errorf("%s (%d chars) stored %d chars", tc.key, len(tc.value), len(got))
			}
			continue
		}
		if msg != tc.msg {
			t.Errorf("%s (%d chars): message = %q, want %q", tc.key, len(tc.value), msg, tc.msg)
		}
		if got := storedSetting(t, database, tc.key); got == tc.value {
			t.Errorf("%s (%d chars) was stored despite the 400", tc.key, len(tc.value))
		}
	}
}

// TestPatchSettings_InvalidValueWritesNothing: one bad value refuses the
// whole patch, so the valid key beside it is not applied either.
func TestPatchSettings_InvalidValueWritesNothing(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)
	w := doRequest(t, handler, http.MethodPatch, "/settings", token,
		map[string]string{"motd": "fresh", "voice_quality": "ultra"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
	if got := storedSetting(t, database, "motd"); got == "fresh" {
		t.Error("motd was applied alongside an invalid voice_quality")
	}
}
