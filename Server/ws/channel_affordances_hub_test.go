package ws_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// messageAffordanceKeys are the per-viewer fields 3A-13 adds to the targeted
// channel_create; the shared channel_update must carry none of them.
var messageAffordanceKeys = []string{"can_delete_others", "can_pin", "can_react"}

type affordanceTriplet struct{ del, pin, react bool }

// affordanceFixture is a Moderator-role user and a Member-role user, both
// registered on a running hub, and one text channel.
type affordanceFixture struct {
	hub              *ws.Hub
	database         *db.DB
	ch               *db.Channel
	modID, memberID  int64
	modSend, memSend chan []byte
}

func newAffordanceFixture(t *testing.T, register bool) *affordanceFixture {
	t.Helper()
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)
	ctx := context.Background()

	// Pin the Moderator and Member masks rather than lean on migration
	// history for the defaults.
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = permissions | ? WHERE id = 3`,
		permissions.ManageMessages|permissions.AddReactions); err != nil {
		t.Fatalf("grant Moderator bits: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = (permissions | ?) & ? WHERE id = 4`,
		permissions.AddReactions, ^permissions.ManageMessages); err != nil {
		t.Fatalf("pin Member bits: %v", err)
	}
	f := &affordanceFixture{hub: hub, database: database, modSend: make(chan []byte, 32), memSend: make(chan []byte, 32)}
	var err error
	if f.modID, err = database.CreateUser(ctx, "afford-mod", "hash", 3); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	f.memberID = seedTestUser(t, database, "afford-member")
	chID := seedTestChannel(t, database, "afford-room")
	if f.ch, err = database.GetChannel(ctx, chID); err != nil || f.ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if register {
		f.registerBoth(t)
	}
	return f
}

func (f *affordanceFixture) registerBoth(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	mod, err := f.database.GetUserByID(ctx, f.modID)
	if err != nil || mod == nil {
		t.Fatalf("GetUserByID mod: %v", err)
	}
	member, err := f.database.GetUserByID(ctx, f.memberID)
	if err != nil || member == nil {
		t.Fatalf("GetUserByID member: %v", err)
	}
	f.hub.Register(ws.NewTestClientWithUser(f.hub, mod, 0, f.modSend))
	memberClient := ws.NewTestClientWithUser(f.hub, member, 0, f.memSend)
	f.hub.Register(memberClient)
	waitRegistered(t, f.hub, memberClient)
}

func (f *affordanceFixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := f.database.ExecContext(context.Background(), q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

// channelCreateTriplet reads the next channel_create for chID and returns its
// three message affordances, failing if any is absent.
func channelCreateTriplet(t *testing.T, send chan []byte, chID int64) affordanceTriplet {
	t.Helper()
	msg := drainForMsgType(t, send, "channel_create")
	payload, ok := msg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("channel_create payload not an object: %#v", msg["payload"])
	}
	if id, _ := payload["id"].(float64); int64(id) != chID {
		t.Fatalf("channel_create id = %v, want %d", payload["id"], chID)
	}
	for _, key := range messageAffordanceKeys {
		if _, present := payload[key]; !present {
			t.Fatalf("targeted channel_create omitted %s", key)
		}
	}
	return affordanceTriplet{payload["can_delete_others"] == true, payload["can_pin"] == true, payload["can_react"] == true}
}

// An override edit lands while a moderator is connected: the targeted
// channel_create carries each recipient's own can_delete_others, can_pin and
// can_react, converging them without a reconnect. This is the first edge
// case's targeted half; TestChannelUpdate_OmitsPerViewerAffordances is the
// shared half.
func TestRefreshChannelVisibility_TargetedCreateCarriesMessageAffordances(t *testing.T) {
	f := newAffordanceFixture(t, true)
	manage := permissions.ManageMessages
	steps := []struct {
		name     string
		sql      string
		args     []any
		mod, mem affordanceTriplet
	}{
		{"no override", "", nil, affordanceTriplet{true, true, true}, affordanceTriplet{false, false, true}},
		{"role deny MANAGE", `INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 3, 0, ?)`, []any{f.ch.ID, manage},
			affordanceTriplet{false, false, true}, affordanceTriplet{false, false, true}},
		{"role deny lifted", `DELETE FROM channel_overrides WHERE channel_id = ? AND role_id = 3`, []any{f.ch.ID},
			affordanceTriplet{true, true, true}, affordanceTriplet{false, false, true}},
		{"moderator user deny MANAGE", `INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, 0, ?)`, []any{f.ch.ID, f.modID, manage},
			affordanceTriplet{false, false, true}, affordanceTriplet{false, false, true}},
		{"member user allow MANAGE", `INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)`, []any{f.ch.ID, f.memberID, manage},
			affordanceTriplet{false, false, true}, affordanceTriplet{true, true, true}},
		{"member role deny ADD_REACTIONS", `INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, ?)`, []any{f.ch.ID, permissions.AddReactions},
			affordanceTriplet{false, false, true}, affordanceTriplet{true, true, false}},
	}
	for _, s := range steps {
		if s.sql != "" {
			f.exec(t, s.sql, s.args...)
		}
		f.hub.RefreshChannelVisibility(f.ch)
		if got := channelCreateTriplet(t, f.modSend, f.ch.ID); got != s.mod {
			t.Errorf("%s: moderator (del, pin, react) = %+v, want %+v", s.name, got, s.mod)
		}
		if got := channelCreateTriplet(t, f.memSend, f.ch.ID); got != s.mem {
			t.Errorf("%s: member (del, pin, react) = %+v, want %+v", s.name, got, s.mem)
		}
	}
}

// A newly created channel has no earlier verdict for an absent field to keep,
// so the creation fan-out carries each recipient's own message affordances.
func TestBroadcastChannelCreate_CarriesPerRecipientMessageAffordances(t *testing.T) {
	f := newAffordanceFixture(t, true)
	chID := seedTestChannel(t, f.database, "afford-new-room")
	ch, err := f.database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	f.hub.BroadcastChannelCreate(ch)
	if got, want := channelCreateTriplet(t, f.modSend, chID), (affordanceTriplet{true, true, true}); got != want {
		t.Errorf("moderator (del, pin, react) = %+v, want %+v", got, want)
	}
	if got, want := channelCreateTriplet(t, f.memSend, chID), (affordanceTriplet{false, false, true}); got != want {
		t.Errorf("member (del, pin, react) = %+v, want %+v", got, want)
	}
}

// The shared channel_update is one encoded frame for every recipient, so it
// carries none of the per-viewer fields: a client that applied them would
// overwrite one viewer's verdict with another's.
func TestChannelUpdate_OmitsPerViewerAffordances(t *testing.T) {
	f := newAffordanceFixture(t, true)
	f.hub.BroadcastChannelUpdate(f.ch)
	for name, send := range map[string]chan []byte{"moderator": f.modSend, "member": f.memSend} {
		msg := drainForMsgType(t, send, "channel_update")
		payload, ok := msg["payload"].(map[string]any)
		if !ok {
			t.Fatalf("%s: channel_update payload not an object: %#v", name, msg["payload"])
		}
		for _, key := range append([]string{"can_send", "can_moderate_voice"}, messageAffordanceKeys...) {
			if _, present := payload[key]; present {
				t.Errorf("%s: channel_update carries per-viewer %s", name, key)
			}
		}
	}
}
