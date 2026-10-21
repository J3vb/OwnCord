package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// WP 6.5a: channel_categories and ready's categories go to MANAGE_CHANNELS
// holders only. Everyone else derives groups from the category fields on the
// channels they can read, so a hidden or empty category's name never reaches
// them.

const moderatorRoleID = 3 // holds MANAGE_CHANNELS in the test schema

func noFrame(t *testing.T, ch chan []byte, who string) {
	t.Helper()
	select {
	case raw := <-ch:
		t.Fatalf("%s received a frame it must not: %s", who, raw)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestBroadcastChannelCategories_OnlyManagersReceiveIt(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	owner := seedOwnerUser(t, database, "cat-owner")
	mod, err := database.CreateUser(context.Background(), "cat-mod", "hash", moderatorRoleID)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	member := seedMemberUser(t, database, "cat-member")

	chans := map[string]chan []byte{}
	for name, id := range map[string]int64{"owner": owner.ID, "mod": mod, "member": member.ID} {
		send := make(chan []byte, 8)
		chans[name] = send
		hub.RegisterNowForTest(ws.NewTestClient(hub, id, send))
	}

	cats := []db.ChannelCategory{{ID: 1, Name: "Staff only secrets", Position: 0}, {ID: 2, Name: "Empty", Position: 1}}
	hub.BroadcastChannelCategories(cats)

	for _, who := range []string{"owner", "mod"} {
		msg := awaitMessage(t, chans[who])
		if msg["type"] != "channel_categories" {
			t.Fatalf("%s got type %v, want channel_categories", who, msg["type"])
		}
		payload, _ := msg["payload"].(map[string]any)
		got, _ := payload["categories"].([]any)
		if len(got) != 2 {
			t.Fatalf("%s got categories %v, want both", who, payload["categories"])
		}
		first, _ := got[0].(map[string]any)
		if first["name"] != "Staff only secrets" || first["id"] != float64(1) || first["position"] != float64(0) {
			t.Fatalf("%s first category = %v", who, first)
		}
	}
	noFrame(t, chans["member"], "a plain member")

	// The permission is read at send time: once the moderator is demoted the
	// next broadcast skips them.
	if err := database.UpdateUserRole(context.Background(), mod, 4); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	hub.BroadcastChannelCategories(cats[:1])
	awaitMessage(t, chans["owner"])
	noFrame(t, chans["mod"], "a demoted moderator")
	noFrame(t, chans["member"], "a plain member")
}

func readyPayload(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var env struct {
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("decode ready: %v", err)
	}
	return env.Payload
}

func buildReadyFor(t *testing.T, hub *ws.Hub, database *db.DB, u *db.User) ([]byte, map[string]any) {
	t.Helper()
	role, err := database.GetRoleByID(context.Background(), u.RoleID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	raw, err := hub.BuildReadyWithRoleForTest(database, u.ID, role)
	if err != nil {
		t.Fatalf("ready: %v", err)
	}
	return raw, readyPayload(t, raw)
}

func TestReady_CategoriesOnlyForManagersAndNeverAHiddenName(t *testing.T) {
	hub, database := newTestHub(t)
	ctx := context.Background()

	owner := seedOwnerUser(t, database, "ready-owner")
	member := seedMemberUser(t, database, "ready-member")

	open, err := database.CreateChannelCategory(ctx, "Open Plaza")
	if err != nil {
		t.Fatal(err)
	}
	hidden, err := database.CreateChannelCategory(ctx, "Hidden Vault")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateChannelCategory(ctx, "Empty Shelf"); err != nil {
		t.Fatal(err)
	}
	visibleID, err := database.CreateChannelIn(ctx, db.NewChannel{Name: "plaza", Type: "text", CategoryID: open.ID})
	if err != nil {
		t.Fatal(err)
	}
	hiddenID, err := database.CreateChannelIn(ctx, db.NewChannel{Name: "vault", Type: "text", CategoryID: hidden.ID})
	if err != nil {
		t.Fatal(err)
	}
	// The member role may not read the vault channel.
	if err := database.UpsertChannelOverride(ctx, hiddenID, 4, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	build := func(u *db.User) ([]byte, map[string]any) { return buildReadyFor(t, hub, database, u) }

	rawOwner, ownerReady := build(owner)
	cats, ok := ownerReady["categories"].([]any)
	if !ok || len(cats) != 3 {
		t.Fatalf("a manager's ready categories = %v, want all three including the empty and the hidden one", ownerReady["categories"])
	}
	names := map[string]bool{}
	for _, c := range cats {
		names[c.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"Open Plaza", "Hidden Vault", "Empty Shelf"} {
		if !names[want] {
			t.Errorf("manager ready is missing category %q: %v", want, cats)
		}
	}

	rawMember, memberReady := build(member)
	if _, present := memberReady["categories"]; present {
		t.Fatalf("a non-manager's ready carries a categories key: %v", memberReady["categories"])
	}
	for _, secret := range []string{"Hidden Vault", "Empty Shelf"} {
		if bytes.Contains(rawMember, []byte(secret)) {
			t.Fatalf("a non-manager's ready contains %q", secret)
		}
	}
	// The visible channel still names its own category, with id and position.
	var plaza map[string]any
	for _, c := range memberReady["channels"].([]any) {
		ch := c.(map[string]any)
		if ch["id"] == float64(visibleID) {
			plaza = ch
		}
		if ch["id"] == float64(hiddenID) {
			t.Fatalf("the member can see the hidden channel")
		}
	}
	if plaza == nil || plaza["category"] != "Open Plaza" || plaza["category_id"] != float64(open.ID) || plaza["category_position"] != float64(open.Position) {
		t.Fatalf("visible channel = %v, want category Open Plaza with its id and position", plaza)
	}
	if !bytes.Contains(rawOwner, []byte(`"categories":[`)) {
		t.Fatal("manager ready should encode categories before channels")
	}
}

func TestReady_ManagerWithNoCategoriesGetsAnEmptyList(t *testing.T) {
	hub, database := newTestHub(t)
	owner := seedOwnerUser(t, database, "ready-owner-none")
	_, ready := buildReadyFor(t, hub, database, owner)
	cats, present := ready["categories"]
	if arr, ok := cats.([]any); !present || !ok || len(arr) != 0 {
		t.Fatalf("categories = %v (present %v), want an empty list so a manager knows there are none", cats, present)
	}
}

func TestChannelUpdate_CarriesCategoryFields(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	ctx := context.Background()
	member := seedMemberUser(t, database, "cu-member")
	send := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, member.ID, send))

	cat, err := database.CreateChannelCategory(ctx, "Lobby")
	if err != nil {
		t.Fatal(err)
	}
	id, err := database.CreateChannelIn(ctx, db.NewChannel{Name: "hall", Type: "text", CategoryID: cat.ID})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := database.GetChannel(ctx, id)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	hub.BroadcastChannelUpdate(ch)
	msg := awaitMessage(t, send)
	payload, _ := msg["payload"].(map[string]any)
	if msg["type"] != "channel_update" || payload["category"] != "Lobby" || payload["category_id"] != float64(cat.ID) || payload["category_position"] != float64(0) {
		t.Fatalf("channel_update = %v, want category Lobby with its id and position", msg)
	}
}
