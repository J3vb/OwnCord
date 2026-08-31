package admin_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// S-03 (B3-8 channel family): the admin surface enforces the one
// rune/normalization contract service.cleanChannelMeta owns. The rune-vs-byte
// distinction and the shared-cap fact are pinned at the service seam
// (service/channel_admin_test.go); these rows pin that the surface actually
// routes through it.
func TestS03_AdminChannelWritesFollowTheContract(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database), newTestSettingsService(database), newTestChannelService(database))
	token := createAdminUser(t, database)

	t.Run("name over the rune cap is refused", func(t *testing.T) {
		w := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{
			"name": strings.Repeat("é", service.MaxChannelNameLen+1),
		})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
		}
		var resp map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err == nil && resp["error"] != "INVALID_INPUT" {
			t.Errorf("error code = %q, want INVALID_INPUT", resp["error"])
		}
	})

	t.Run("name at the rune cap is accepted", func(t *testing.T) {
		// 100 two-byte runes = 200 bytes: a byte-counting bound would refuse it.
		w := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{
			"name": strings.Repeat("é", service.MaxChannelNameLen),
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
		}
	})

	t.Run("stored values are cleaned like every sidebar field", func(t *testing.T) {
		w := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{
			"name":     "  <b>clean-me</b>  ",
			"topic":    " topic <i>x</i> ",
			"category": "  Chat  ",
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
		}
		var ch db.Channel
		if err := json.Unmarshal(w.Body.Bytes(), &ch); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if ch.Name != "clean-me" || ch.Topic != "topic x" || ch.Category != "Chat" {
			t.Fatalf("stored %q/%q/%q, want clean-me/topic x/Chat", ch.Name, ch.Topic, ch.Category)
		}
	})

	t.Run("topic over its cap is refused on PATCH too", func(t *testing.T) {
		create := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{"name": "s03-patch"})
		var ch db.Channel
		if err := json.Unmarshal(create.Body.Bytes(), &ch); err != nil {
			t.Fatalf("unmarshal create: %v", err)
		}
		w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(ch.ID), token, map[string]any{
			"name":  "s03-patch",
			"topic": strings.Repeat("t", service.MaxChannelTopicLen+1),
		})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
		}
	})
}
