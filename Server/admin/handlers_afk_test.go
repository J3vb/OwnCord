package admin_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The route sits in the ManageServer group: a plain member, and a caller with
// some other permission, are refused before anything is written, while a
// caller holding exactly MANAGE_SERVER may set the flag.
func TestAdminAFKRoute_RequiresManageServer(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	chID, err := database.AdminCreateChannel(context.Background(), "lounge", "voice", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	memberToken := createMemberUser(t, database)
	_, channelsOnlyToken := createRoleUser(t, database, 14, "Channels", permissions.ManageChannels, 50, "chanmanager")
	_, serverToken := createRoleUser(t, database, 15, "Server", permissions.ManageServer, 50, "srvmanager")

	body := map[string]any{"channel_id": chID}
	for _, tc := range []struct {
		name, token string
		want        int
	}{
		{"no token", "", http.StatusUnauthorized},
		{"member", memberToken, http.StatusForbidden},
		{"manage channels only", channelsOnlyToken, http.StatusForbidden},
		{"manage server", serverToken, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := doRequest(t, handler, http.MethodPut, "/afk-channel", tc.token, body)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d; body: %s", w.Code, tc.want, w.Body.String())
			}
		})
	}
	var afk int
	if err := database.QueryRowContext(context.Background(), `SELECT afk FROM channels WHERE id = ?`, chID).Scan(&afk); err != nil || afk != 1 {
		t.Fatalf("afk = %d err=%v, want the ManageServer caller's write to stick", afk, err)
	}
	if len(hub.channelUpdates) != 1 {
		t.Fatalf("channel_update broadcasts = %d, want 1 (refused callers broadcast nothing)", len(hub.channelUpdates))
	}
}

// Switching the flag clears the old channel and sets the new one, and both
// channels are broadcast (the old with afk false, the new with afk true).
// Clearing broadcasts the channel that lost the flag, and a request that
// changes nothing broadcasts nothing.
func TestSetAFKChannel_SwitchClearsPreviousAndBroadcastsBoth(t *testing.T) {
	ctx := context.Background()
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)
	a, _ := database.AdminCreateChannel(ctx, "lounge", "voice", "", "", 0)
	b, _ := database.AdminCreateChannel(ctx, "parking", "voice", "", "", 1)

	put := func(body string) int {
		return doRequestRaw(t, handler, http.MethodPut, "/afk-channel", token, body).Code
	}
	flagged := func() []int64 {
		rows, err := database.QueryContext(ctx, `SELECT id FROM channels WHERE afk = 1`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		return ids
	}

	if code := put(`{"channel_id": ` + itoa(a) + `}`); code != http.StatusOK {
		t.Fatalf("set a: status %d", code)
	}
	if got := flagged(); len(got) != 1 || got[0] != a {
		t.Fatalf("flagged = %v, want [%d]", got, a)
	}
	if len(hub.channelUpdates) != 1 || hub.channelUpdates[0].ID != a || !hub.channelUpdates[0].AFK {
		t.Fatalf("first broadcast = %+v, want channel %d with afk", hub.channelUpdates, a)
	}

	hub.channelUpdates = nil
	if code := put(`{"channel_id": ` + itoa(b) + `}`); code != http.StatusOK {
		t.Fatalf("switch to b: status %d", code)
	}
	if got := flagged(); len(got) != 1 || got[0] != b {
		t.Fatalf("flagged after switch = %v, want [%d]", got, b)
	}
	if len(hub.channelUpdates) != 2 {
		t.Fatalf("switch broadcast %d channel_updates, want 2", len(hub.channelUpdates))
	}
	seen := map[int64]bool{}
	for _, ch := range hub.channelUpdates {
		seen[ch.ID] = ch.AFK
	}
	if afkA, okA := seen[a]; !okA || afkA {
		t.Errorf("channel %d broadcast = (%v, %v), want present with afk false", a, afkA, okA)
	}
	if afkB, okB := seen[b]; !okB || !afkB {
		t.Errorf("channel %d broadcast = (%v, %v), want present with afk true", b, afkB, okB)
	}

	hub.channelUpdates = nil
	if code := put(`{"channel_id": ` + itoa(b) + `}`); code != http.StatusOK || len(hub.channelUpdates) != 0 {
		t.Fatalf("repeat set: status %d, broadcasts %d, want 200 and none", code, len(hub.channelUpdates))
	}
	if code := put(`{"channel_id": null}`); code != http.StatusOK {
		t.Fatalf("clear: status %d", code)
	}
	if got := flagged(); len(got) != 0 {
		t.Fatalf("flagged after clear = %v, want none", got)
	}
	if len(hub.channelUpdates) != 1 || hub.channelUpdates[0].ID != b || hub.channelUpdates[0].AFK {
		t.Fatalf("clear broadcast = %+v, want channel %d with afk false", hub.channelUpdates, b)
	}

	// Malformed bodies change nothing.
	for _, body := range []string{`{}`, `{"channel_id": "x"}`, `not json`} {
		if code := put(body); code != http.StatusBadRequest {
			t.Errorf("body %q: status %d, want 400", body, code)
		}
	}
}
