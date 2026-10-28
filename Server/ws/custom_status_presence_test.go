package ws

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/service"
)

func TestPresenceUpdate_ExpiresInParse(t *testing.T) {
	ctor, ok := getCommandConstructor(MsgTypePresenceUpdate)
	if !ok {
		t.Fatal("no presence_update constructor")
	}
	cases := []struct {
		name    string
		payload string
		wantErr bool
		want    int64 // 0 = absent
	}{
		{"absent", `{"status":"online","custom_status":"x"}`, false, 0},
		{"null", `{"status":"online","custom_status":"x","custom_status_expires_in":null}`, false, 0},
		{"minimum", `{"status":"online","custom_status":"x","custom_status_expires_in":60}`, false, 60},
		{"maximum", `{"status":"online","custom_status":"x","custom_status_expires_in":604800}`, false, 604800},
		{"below minimum", `{"status":"online","custom_status":"x","custom_status_expires_in":59}`, true, 0},
		{"above maximum", `{"status":"online","custom_status":"x","custom_status_expires_in":604801}`, true, 0},
		{"string", `{"status":"online","custom_status":"x","custom_status_expires_in":"600"}`, true, 0},
		{"fraction", `{"status":"online","custom_status":"x","custom_status_expires_in":60.5}`, true, 0},
		{"without custom_status", `{"status":"online","custom_status_expires_in":600}`, true, 0},
		{"with empty custom_status", `{"status":"online","custom_status":"","custom_status_expires_in":600}`, true, 0},
		{"with blank custom_status", `{"status":"online","custom_status":"   ","custom_status_expires_in":600}`, true, 0},
	}
	for _, tc := range cases {
		cmd, err := ctor(1, "", json.RawMessage(tc.payload))
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: parsed, want an error", tc.name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		got := cmd.(PresenceUpdateCmd).ExpiresIn
		if (tc.want == 0) != (got == nil) || (got != nil && *got != tc.want) {
			t.Errorf("%s: ExpiresIn = %v, want %d", tc.name, got, tc.want)
		}
	}
}

func newPresenceFixture(t *testing.T) (*service.Services, *Hub, *db.User, *db.DB) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateUser(context.Background(), "presencer", "hash", 1); err != nil {
		t.Fatal(err)
	}
	user, err := database.GetUserByUsername(context.Background(), "presencer")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	svc := service.New(database, auth.NewRateLimiter())
	return svc, newTestHub(t, database, nil, svc), user, database
}

func presenceFrameOf(t *testing.T, res Result) expiryFrame {
	t.Helper()
	if len(res.Events) == 0 {
		t.Fatal("no events")
	}
	pe, ok := res.Events[0].(PresenceEvent)
	if !ok {
		t.Fatalf("event 0 = %T, want PresenceEvent", res.Events[0])
	}
	return decodeExpiryFrame(t, pe.Payload())
}

func TestHandlePresenceUpdate_StoresExpiryAndTagsLivePresence(t *testing.T) {
	svc, _, user, _ := newPresenceFixture(t)
	text := "in a meeting"
	in := int64(3600)
	res := handlePresenceV2(context.Background(),
		PresenceUpdateCmd{userID: user.ID, Status: db.StatusDND, CustomStatus: &text, ExpiresIn: &in},
		ClientInfo{UserID: user.ID}, PresenceDeps{ChannelSvc: svc.Channels, Limiter: auth.NewRateLimiter()})
	if res.Error != nil {
		t.Fatalf("error: %v", res.Error)
	}
	if res.SetPresence == nil || res.SetPresence.customStatus == nil || res.SetPresence.customStatusExpiresAt == "" {
		t.Fatalf("SetPresence = %+v, want text and the expiry tag", res.SetPresence)
	}
	at, err := time.Parse(dbtime.ISOLayout, res.SetPresence.customStatusExpiresAt)
	if err != nil || time.Until(at) < 59*time.Minute || time.Until(at) > 61*time.Minute {
		t.Fatalf("tag %q is not about an hour away (%v)", res.SetPresence.customStatusExpiresAt, err)
	}
	if f := presenceFrameOf(t, res); f.Payload.CustomStatus == nil || *f.Payload.CustomStatus != text {
		t.Fatalf("frame = %+v, want the text", f)
	}
	// The broadcast never carries the instant.
	if pe := res.Events[0].(PresenceEvent); strings.Contains(string(pe.Payload()), "expires") {
		t.Fatalf("presence frame leaks the expiry: %s", pe.Payload())
	}
}

func TestHandlePresenceUpdate_GuardDropsExpiredText(t *testing.T) {
	svc, _, user, database := newPresenceFixture(t)
	ctx := context.Background()
	text := "stale"
	past := time.Now().UTC().Add(-time.Minute).Format(dbtime.ISOLayout)
	if err := database.UpdateUserPresence(ctx, user.ID, db.StatusOnline, &text, &past); err != nil {
		t.Fatal(err)
	}
	// A bare flip reads the stored row, which the expirer has not cleared yet.
	res := handlePresenceV2(ctx, PresenceUpdateCmd{userID: user.ID, Status: db.StatusIdle},
		ClientInfo{UserID: user.ID}, PresenceDeps{ChannelSvc: svc.Channels, Limiter: auth.NewRateLimiter()})
	if res.Error != nil {
		t.Fatalf("error: %v", res.Error)
	}
	if f := presenceFrameOf(t, res); f.Payload.CustomStatus != nil {
		t.Fatalf("frame custom_status = %q, want null for an expired status", *f.Payload.CustomStatus)
	}
	if res.SetPresence.customStatus != nil || res.SetPresence.customStatusExpiresAt != "" {
		t.Fatalf("live presence = %+v, want no status and no tag", res.SetPresence)
	}
}

func TestAuthOK_CustomStatusExpiresAt(t *testing.T) {
	_, hub, user, _ := newPresenceFixture(t)
	text := "heads down"
	future := time.Now().UTC().Add(time.Hour).Format(dbtime.ISOLayout)
	past := time.Now().UTC().Add(-time.Hour).Format(dbtime.ISOLayout)
	read := func(u *db.User) map[string]any {
		var env struct {
			Payload struct {
				User map[string]any `json:"user"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(hub.buildAuthOK(context.Background(), u, "owner", nil, "none"), &env); err != nil {
			t.Fatal(err)
		}
		return env.Payload.User
	}

	user.CustomStatus, user.CustomStatusExpiresAt = &text, &future
	got := read(user)
	if got["custom_status"] != text || got["custom_status_expires_at"] != future {
		t.Errorf("live status: auth_ok user = %v", got)
	}
	user.CustomStatusExpiresAt = nil
	got = read(user)
	if v, ok := got["custom_status_expires_at"]; !ok || v != nil {
		t.Errorf("no expiry: custom_status_expires_at = %v (present %v), want null", v, ok)
	}
	user.CustomStatusExpiresAt = &past
	got = read(user)
	if got["custom_status"] != nil || got["custom_status_expires_at"] != nil {
		t.Errorf("expired status: auth_ok user = %v, want both null", got)
	}
}
