package admin_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

const channelPasswordSecret = "hunter two"

func patchChannel(t *testing.T, handler http.Handler, token string, id int64, body map[string]any) (int, string) {
	t.Helper()
	w := doRequest(t, handler, http.MethodPatch, fmt.Sprintf("/channels/%d", id), token, body)
	return w.Code, w.Body.String()
}

func requireNoPasswordLeak(t *testing.T, where, body string) {
	t.Helper()
	for _, bad := range []string{"password_hash", "$2a$", "$2b$", channelPasswordSecret} {
		if strings.Contains(body, bad) {
			t.Errorf("%s leaks %q: %s", where, bad, body)
		}
	}
}

func TestPatchChannel_PasswordSetChangeRemove(t *testing.T) {
	handler, token, database := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "locked-room", "voice")

	code, body := patchChannel(t, handler, token, id, map[string]any{"password": channelPasswordSecret})
	if code != http.StatusOK {
		t.Fatalf("set: status = %d; body: %s", code, body)
	}
	requireNoPasswordLeak(t, "PATCH response", body)
	if !strings.Contains(body, `"password_protected":true`) {
		t.Errorf("PATCH response lacks password_protected true: %s", body)
	}

	hash, version, found, err := database.ChannelPasswordState(context.Background(), id)
	if err != nil || !found || hash == "" || version != 1 {
		t.Fatalf("stored state: hash set=%v version=%d found=%v err=%v", hash != "", version, found, err)
	}
	if !auth.CheckPassword(hash, channelPasswordSecret) {
		t.Fatal("stored hash does not match the password that was set")
	}

	// Another edit that does not name the password leaves it alone.
	if code, body = patchChannel(t, handler, token, id, map[string]any{"topic": "chat"}); code != http.StatusOK {
		t.Fatalf("topic: status = %d; body: %s", code, body)
	}
	if _, v, _, _ := database.ChannelPasswordState(context.Background(), id); v != 1 {
		t.Fatalf("version after an unrelated edit = %d, want 1", v)
	}

	// GET never shows it either.
	w := doRequest(t, handler, http.MethodGet, "/channels", token, nil)
	requireNoPasswordLeak(t, "GET /channels", w.Body.String())
	if !strings.Contains(w.Body.String(), `"password_protected":true`) {
		t.Errorf("GET /channels lacks password_protected true: %s", w.Body.String())
	}

	// Changing bumps the version again.
	if code, body = patchChannel(t, handler, token, id, map[string]any{"password": "another one"}); code != http.StatusOK {
		t.Fatalf("change: status = %d; body: %s", code, body)
	}
	if _, v, _, _ := database.ChannelPasswordState(context.Background(), id); v != 2 {
		t.Fatalf("version after a change = %d, want 2", v)
	}

	// An empty string removes it.
	code, body = patchChannel(t, handler, token, id, map[string]any{"password": ""})
	if code != http.StatusOK {
		t.Fatalf("remove: status = %d; body: %s", code, body)
	}
	if !strings.Contains(body, `"password_protected":false`) {
		t.Errorf("PATCH response after removal lacks password_protected false: %s", body)
	}
	hash, v, _, _ := database.ChannelPasswordState(context.Background(), id)
	if hash != "" || v != 3 {
		t.Fatalf("after removal: hash set=%v version=%d, want none and 3", hash != "", v)
	}

	// The audit trail names the three changes and never the secret or a hash.
	rows, err := database.QueryContext(context.Background(), `SELECT detail FROM audit_log WHERE action = 'channel_update'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var details []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			t.Fatal(err)
		}
		requireNoPasswordLeak(t, "audit detail", d)
		details = append(details, d)
	}
	all := strings.Join(details, "\n")
	for _, want := range []string{"(password set)", "(password changed)", "(password removed)"} {
		if !strings.Contains(all, want) {
			t.Errorf("audit details lack %q: %s", want, all)
		}
	}
}

func TestPatchChannel_PasswordOnlyOnVoiceChannels(t *testing.T) {
	handler, token, _ := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "plain-text", "text")

	for _, pw := range []string{channelPasswordSecret, ""} {
		code, body := patchChannel(t, handler, token, id, map[string]any{"password": pw})
		if code != http.StatusBadRequest {
			t.Errorf("password %q on a text channel: status = %d, want 400; body: %s", pw, code, body)
		}
		if !strings.Contains(body, "voice channel") {
			t.Errorf("error should say it is voice only: %s", body)
		}
	}
}

func TestPatchChannel_PasswordValidation(t *testing.T) {
	handler, token, database := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "validated", "voice")

	cases := map[string]string{
		"too long":          strings.Repeat("a", 65),
		"control character": "bad\x07pass",
		"newline":           "two\nlines",
	}
	for name, pw := range cases {
		if code, body := patchChannel(t, handler, token, id, map[string]any{"password": pw}); code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400; body: %s", name, code, body)
		}
	}
	if hash, v, _, _ := database.ChannelPasswordState(context.Background(), id); hash != "" || v != 0 {
		t.Fatalf("a refused password changed state: hash set=%v version=%d", hash != "", v)
	}
	if code, body := patchChannel(t, handler, token, id, map[string]any{"password": strings.Repeat("a", 64)}); code != http.StatusOK {
		t.Errorf("64 characters: status = %d, want 200; body: %s", code, body)
	}
}

// Removing a password the channel does not have changes nothing, version
// included.
func TestPatchChannel_RemovingAbsentPasswordIsANoOp(t *testing.T) {
	handler, token, database := newChannelTestAPI(t)
	id := newChannel(t, handler, token, "never-locked", "voice")
	if code, body := patchChannel(t, handler, token, id, map[string]any{"password": ""}); code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", code, body)
	}
	if _, v, _, _ := database.ChannelPasswordState(context.Background(), id); v != 0 {
		t.Fatalf("version = %d, want 0", v)
	}
}
