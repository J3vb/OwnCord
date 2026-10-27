package ws

// voice_device_key_internal_test.go — the voice E2EE identity key per device.
// The auth frame's identity_public_key rides on the connection (Client.
// identityKey), is stored on the session row, and is attached to every
// voice_e2ee_announce that connection makes: the live relay and each replay.
// Run with -race.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

const (
	devKeyA = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=" // device A identity key
	devKeyB = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=" // device B identity key
	devKeyO = "T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT08=" // observer's key
)

// announce makes d announce pub through a real voice_e2ee_announce frame.
func (f *mdFix) announce(d *mdDev, pub string) {
	f.t.Helper()
	f.hub.handleMessage(d.c, voiceFrame(f.t, "voice_e2ee_announce", "ann-"+pub, map[string]any{"public_key": pub}))
}

// announceFrom matches a voice_e2ee_announce relayed for uid carrying pub.
func announceFrom(uid int64, pub string) func(map[string]any) bool {
	return func(p map[string]any) bool {
		return int64Of(p["user_id"]) == uid && p["public_key"] == pub
	}
}

// keyOf returns the identity_public_key of frame i and whether it was present.
func keyOf(d *mdDev, i int) (string, bool) {
	v, ok := framePayload(d.got[i])["identity_public_key"]
	s, _ := v.(string)
	return s, ok
}

func (f *mdFix) leave(d *mdDev) {
	f.t.Helper()
	f.hub.handleMessage(d.c, voiceFrame(f.t, "voice_leave", "leave", map[string]any{}))
}

func TestDeviceKey_AnnounceCarriesTheSendingDevicesKey_LiveAndReplay(t *testing.T) {
	f := newMDFix(t)
	obs := f.observer(f.text)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	a.c.identityKey = devKeyA
	b.c.identityKey = devKeyB

	// Live: observer is already in the call when device A announces.
	f.join(obs, f.voiceA)
	f.join(a, f.voiceA)
	f.announce(a, "cHViLWE=")
	i := obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLWE="))
	if k, ok := keyOf(obs, i); !ok || k != devKeyA {
		t.Fatalf("live announce from device A carries key %q (present=%v), want %q", k, ok, devKeyA)
	}

	// The call moves to device B, which announces its own key.
	f.join(b, f.voiceA)
	f.announce(b, "cHViLWI=")
	i = obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLWI="))
	if k, ok := keyOf(obs, i); !ok || k != devKeyB {
		t.Fatalf("live announce from device B carries key %q (present=%v), want %q", k, ok, devKeyB)
	}

	// Replay after the move: a joiner is handed B's announce with B's key,
	// never A's.
	f.leave(obs)
	obs.pump()
	obs.got = nil
	f.join(obs, f.voiceA)
	i = obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLWI="))
	if k, ok := keyOf(obs, i); !ok || k != devKeyB {
		t.Fatalf("replayed announce after the move carries key %q (present=%v), want device B's %q", k, ok, devKeyB)
	}
	obs.settle()
	if obs.index(0, MsgTypeVoiceE2EEAnnounceBC, func(p map[string]any) bool { return p["identity_public_key"] == devKeyA }) >= 0 {
		t.Fatalf("a replay after the move still carried device A's key; got %s", obs.types())
	}

	// Switching back to A: the replay carries A's key again.
	f.join(a, f.voiceA)
	f.announce(a, "cHViLWEy")
	obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLWEy"))
	f.leave(obs)
	obs.pump()
	obs.got = nil
	f.join(obs, f.voiceA)
	i = obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLWEy"))
	if k, ok := keyOf(obs, i); !ok || k != devKeyA {
		t.Fatalf("replayed announce after moving back carries key %q (present=%v), want %q", k, ok, devKeyA)
	}
}

func TestDeviceKey_OldAndNewClientsMixed(t *testing.T) {
	f := newMDFix(t)
	obs := f.observer(f.text)
	old := f.dev("session-old", f.text) // an older client: no key in its auth frame
	obs.c.identityKey = devKeyO         // a current client

	f.join(obs, f.voiceA)
	f.join(old, f.voiceA)
	f.announce(old, "cHViLW9sZA==")
	i := obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLW9sZA=="))
	if k, ok := keyOf(obs, i); ok {
		t.Fatalf("live announce from a client without a key carries identity_public_key %q", k)
	}
	if raw, _ := json.Marshal(obs.got[i]); strings.Contains(string(raw), "identity_public_key") {
		t.Fatalf("announce JSON mentions identity_public_key: %s", raw)
	}

	// The reverse direction: the old client sees the current client's key and
	// is free to ignore it.
	f.announce(obs, "cHViLW9icw==")
	j := old.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.oid, "cHViLW9icw=="))
	if k, ok := keyOf(old, j); !ok || k != devKeyO {
		t.Fatalf("announce from the current client carries key %q (present=%v), want %q", k, ok, devKeyO)
	}

	// Replay of the key-less announce to a joiner also omits the field.
	f.leave(obs)
	obs.pump()
	obs.got = nil
	f.join(obs, f.voiceA)
	i = obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLW9sZA=="))
	if _, ok := keyOf(obs, i); ok {
		t.Fatal("replayed announce from a client without a key carries identity_public_key")
	}
}

func TestDeviceKey_ResumeRepeatsOwnAnnounceWithItsKey(t *testing.T) {
	f := newMDFix(t)
	obs := f.observer(f.text)
	a := f.dev("session-a", f.text)
	a.c.identityKey = devKeyA
	f.join(obs, f.voiceA)
	f.join(a, f.voiceA)
	f.announce(a, "cHViLWE=")
	obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLWE="))
	obs.got = nil

	// The same session reconnects (registerNow re-relays the stored announce).
	a2 := f.newConn(f.uid, "session-a", f.text)
	a2.identityKey = devKeyA
	a2.lastSeq = 1 // network reconnect: the call is kept
	f.hub.registerNowTest(a2, map[int64]bool{f.text: true})
	i := obs.await(t, MsgTypeVoiceE2EEAnnounceBC, announceFrom(f.uid, "cHViLWE="))
	if k, ok := keyOf(obs, i); !ok || k != devKeyA {
		t.Fatalf("resume re-relay carries key %q (present=%v), want %q", k, ok, devKeyA)
	}
}

func TestAuthIdentityKey(t *testing.T) {
	long := strings.Repeat("A", 129)
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"absent", ``, ""},
		{"null", `null`, ""},
		{"valid padded", `"` + devKeyA + `"`, devKeyA},
		{"valid unpadded", `"QUJD"`, "QUJD"},
		{"surrounding whitespace trimmed", `"  QUJD "`, "QUJD"},
		{"empty string", `""`, ""},
		{"not base64", `"not base64!"`, ""},
		{"too long", `"` + long + `"`, ""},
		{"number", `12`, ""},
		{"object", `{"a":1}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := authIdentityKey(1, json.RawMessage(tc.raw)); got != tc.want {
				t.Fatalf("authIdentityKey(%s) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// dialWithAuth opens a socket against hub, sends payload as the auth frame and
// returns the first frame type.
func dialWithAuth(t *testing.T, hub *Hub, payload map[string]any) string {
	t.Helper()
	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": payload})
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	typ, _ := readFrameType(t, ctx, conn)
	return typ
}

func sessionKey(t *testing.T, f *mdFix, token string) (string, bool) {
	t.Helper()
	var key *string
	err := f.db.SQLDb().QueryRowContext(context.Background(),
		`SELECT identity_public_key FROM sessions WHERE token = ?`, auth.HashToken(token)).Scan(&key)
	if err != nil {
		t.Fatalf("read session key: %v", err)
	}
	if key == nil {
		return "", false
	}
	return *key, true
}

func TestDeviceKey_AuthFrameStoresKeyOnConnectionAndSession(t *testing.T) {
	cases := []struct {
		name    string
		payload func(token string) map[string]any
		want    string // the key the connection and session should hold
	}{
		{"valid key", func(tok string) map[string]any {
			return map[string]any{"token": tok, "identity_public_key": devKeyA}
		}, devKeyA},
		{"old client, no key", func(tok string) map[string]any {
			return map[string]any{"token": tok}
		}, ""},
		{"invalid key, auth still succeeds", func(tok string) map[string]any {
			return map[string]any{"token": tok, "identity_public_key": "***not base64***"}
		}, ""},
		{"wrongly typed key, auth still succeeds", func(tok string) map[string]any {
			return map[string]any{"token": tok, "identity_public_key": 42}
		}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newMDFix(t)
			token, err := auth.GenerateToken()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.CreateSession(context.Background(), f.uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
				t.Fatal(err)
			}
			if typ := dialWithAuth(t, f.hub, tc.payload(token)); typ != MsgTypeAuthOK {
				t.Fatalf("first frame = %q, want auth_ok", typ)
			}
			var c *Client
			waitFor(t, "the connection to register", func() bool {
				c = f.hub.ClientForTest(f.uid)
				return c != nil
			})
			if c.identityKey != tc.want {
				t.Fatalf("Client.identityKey = %q, want %q", c.identityKey, tc.want)
			}
			got, present := sessionKey(t, f, token)
			if got != tc.want || present != (tc.want != "") {
				t.Fatalf("sessions.identity_public_key = %q (present=%v), want %q", got, present, tc.want)
			}
		})
	}
}
