package admin_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// S-03 (B3-8 channel family): the admin surface enforces the one
// rune/normalization contract service.cleanChannelMeta owns. The rune-vs-byte
// distinction and the shared-cap fact are pinned at the service seam
// (service/channel_admin_test.go); these rows pin that the surface actually
// routes through it.
func TestS03_AdminChannelWritesFollowTheContract(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	t.Run("name over the rune cap is refused", func(t *testing.T) {
		w := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{
			"name": strings.Repeat("é", service.MaxChannelNameLen+1),
		})
		requireStatus(t, w, http.StatusBadRequest)
		resp := decodeBody[map[string]string](t, w)
		if resp["error"] != "INVALID_INPUT" {
			t.Errorf("error code = %q, want INVALID_INPUT", resp["error"])
		}
		// The body is the validation text alone — no rendered sentinel prefix
		// ("bad request: ..."), the contract a review caught the prefixed
		// wraps breaking.
		if want := "name must be at most 100 characters"; resp["message"] != want {
			t.Errorf("message = %q, want %q", resp["message"], want)
		}
	})

	t.Run("name at the rune cap is accepted", func(t *testing.T) {
		// 100 two-byte runes = 200 bytes: a byte-counting bound would refuse it.
		w := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{
			"name": strings.Repeat("é", service.MaxChannelNameLen),
		})
		requireStatus(t, w, http.StatusCreated)
	})

	t.Run("stored values are cleaned like every sidebar field", func(t *testing.T) {
		w := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{
			"name":     "  <b>clean-me</b>  ",
			"topic":    " topic <i>x</i> ",
			"category": "  Chat  ",
		})
		requireStatus(t, w, http.StatusCreated)
		ch := decodeBody[db.Channel](t, w)
		if ch.Name != "clean-me" || ch.Topic != "topic x" || ch.Category != "Chat" {
			t.Fatalf("stored %q/%q/%q, want clean-me/topic x/Chat", ch.Name, ch.Topic, ch.Category)
		}
	})

	t.Run("topic over its cap is refused on PATCH too", func(t *testing.T) {
		create := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{"name": "s03-patch"})
		ch := decodeBody[db.Channel](t, create)
		w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(ch.ID), token, map[string]any{
			"name":  "s03-patch",
			"topic": strings.Repeat("t", service.MaxChannelTopicLen+1),
		})
		requireStatus(t, w, http.StatusBadRequest)
	})
}
