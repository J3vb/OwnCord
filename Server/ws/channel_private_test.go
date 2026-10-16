package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// defaultRoleID is the seeded Member role: the is_default role.
const defaultRoleID = 4

func readyChannelsByID(t *testing.T, raw []byte) map[int64]map[string]any {
	t.Helper()
	var env struct {
		Payload struct {
			Channels []map[string]any `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	out := make(map[int64]map[string]any, len(env.Payload.Channels))
	for _, ch := range env.Payload.Channels {
		id, ok := ch["id"].(float64)
		if !ok {
			t.Fatalf("channel %v has no numeric id", ch)
		}
		out[int64(id)] = ch
	}
	return out
}

func denyDefaultRoleRead(t *testing.T, database *db.DB, channelID int64) {
	t.Helper()
	if err := database.UpsertChannelOverride(context.Background(), channelID, defaultRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
}

func readyFor(t *testing.T, hub *ws.Hub, database *db.DB, userID int64) []byte {
	t.Helper()
	owner, err := database.GetRoleByID(context.Background(), 1)
	if err != nil || owner == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	raw, err := hub.BuildReadyWithRoleForTest(database, userID, owner)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}
	return raw
}

// A private text channel and a private voice channel carry private=true; a
// public one carries an explicit false (never omitted).
func TestBuildReady_PrivateFlag(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "private-ready")
	ctx := context.Background()
	pubID, _ := database.CreateChannel(ctx, "public", "text", "", "", 0)
	privTextID, _ := database.CreateChannel(ctx, "staff", "text", "", "", 1)
	privVoiceID, _ := database.CreateChannel(ctx, "staff-voice", "voice", "", "", 2)
	allowID, _ := database.CreateChannel(ctx, "allowed", "text", "", "", 3)
	denyDefaultRoleRead(t, database, privTextID)
	denyDefaultRoleRead(t, database, privVoiceID)
	// An override that does not touch READ_MESSAGES leaves the channel public.
	if err := database.UpsertChannelOverride(ctx, allowID, defaultRoleID, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	byID := readyChannelsByID(t, readyFor(t, hub, database, user.ID))
	for id, want := range map[int64]bool{pubID: false, privTextID: true, privVoiceID: true, allowID: false} {
		ch, ok := byID[id]
		if !ok {
			t.Fatalf("channel %d missing from ready", id)
		}
		got, present := ch["private"]
		if !present {
			t.Fatalf("channel %d: private is omitted", id)
		}
		if got != want {
			t.Errorf("channel %d: private = %v, want %v", id, got, want)
		}
	}
}

// Edge case 2: no default role row. The frame is not failed and nothing is
// private.
func TestPrivateFlag_NoDefaultRoleIsNotPrivate(t *testing.T) {
	f := newAffordanceFixture(t, true)
	denyDefaultRoleRead(t, f.database, f.ch.ID)
	f.exec(t, `UPDATE roles SET is_default = 0`)

	byID := readyChannelsByID(t, readyFor(t, f.hub, f.database, f.modID))
	ch, ok := byID[f.ch.ID]
	if !ok {
		t.Fatalf("channel missing from ready")
	}
	if ch["private"] != false {
		t.Errorf("ready private = %v, want false with no default role", ch["private"])
	}

	f.hub.BroadcastChannelUpdate(f.ch)
	payload, _ := drainForMsgType(t, f.modSend, "channel_update")["payload"].(map[string]any)
	if payload["private"] != false {
		t.Errorf("channel_update private = %v, want false with no default role", payload["private"])
	}
}

// An override edit flips the flag on the next channel_update, and on the
// channel_create RefreshChannelVisibility sends to users who can still see the
// channel; both frames carry the same value for every recipient.
func TestPrivateFlag_FramesFollowOverrideChange(t *testing.T) {
	f := newAffordanceFixture(t, true)

	updateFlag := func(send chan []byte) any {
		p, _ := drainForMsgType(t, send, "channel_update")["payload"].(map[string]any)
		return p["private"]
	}
	createFlag := func(send chan []byte) any {
		p, _ := drainForMsgType(t, send, "channel_create")["payload"].(map[string]any)
		return p["private"]
	}

	f.hub.BroadcastChannelUpdate(f.ch)
	if got := updateFlag(f.modSend); got != false {
		t.Errorf("channel_update before override: private = %v, want false", got)
	}
	if got := updateFlag(f.memSend); got != false {
		t.Errorf("channel_update before override (member): private = %v, want false", got)
	}

	// Deny the default role READ; the moderator (role 3) still reads, so the
	// refresh sends it a channel_create. The member loses the channel.
	denyDefaultRoleRead(t, f.database, f.ch.ID)
	f.hub.RefreshChannelVisibility(f.ch)
	if got := createFlag(f.modSend); got != true {
		t.Errorf("refresh channel_create after deny: private = %v, want true", got)
	}
	f.hub.BroadcastChannelUpdate(f.ch)
	if got := updateFlag(f.modSend); got != true {
		t.Errorf("channel_update after deny: private = %v, want true", got)
	}

	// Lifting the override flips it back.
	if err := f.database.DeleteChannelOverride(context.Background(), f.ch.ID, defaultRoleID); err != nil {
		t.Fatalf("DeleteChannelOverride: %v", err)
	}
	f.hub.RefreshChannelVisibility(f.ch)
	if got := createFlag(f.modSend); got != false {
		t.Errorf("refresh channel_create after lift: private = %v, want false", got)
	}
}

// racingPrivacy edits the world right after the ready build's one snapshot
// read: it deletes the channel (and with it the override), so the snapshot the
// flag was computed from is already stale by the time ready is encoded.
type racingPrivacy struct {
	ws.ChannelPrivacy
	database  *db.DB
	channelID int64
	reads     int
}

func (r *racingPrivacy) Snapshot(ctx context.Context) (service.ChannelPrivacySnapshot, error) {
	r.reads++
	got, err := r.ChannelPrivacy.Snapshot(ctx)
	if _, delErr := r.database.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, r.channelID); delErr != nil {
		return service.ChannelPrivacySnapshot{}, delErr
	}
	return got, err
}

// Edge case 1: an override changed (here: its channel deleted) while ready is
// building. The flag comes from the single snapshot read, ready is built once,
// and nothing panics on the vanished channel.
func TestBuildReady_PrivateFlagUsesOneSnapshot(t *testing.T) {
	database := openCoverageDB(t)
	ctx := context.Background()
	rp := &racingPrivacy{ChannelPrivacy: service.NewChannelPrivacyService(database), database: database}
	hub := newTestHubWith(t, ws.HubOptions{DB: database, ChannelPrivacy: rp})
	user := seedCoverageOwner(t, database, "private-race")
	goneID, _ := database.CreateChannel(ctx, "vanishing", "text", "", "", 0)
	keepID, _ := database.CreateChannel(ctx, "stays", "text", "", "", 1)
	denyDefaultRoleRead(t, database, goneID)
	denyDefaultRoleRead(t, database, keepID)
	rp.channelID = goneID

	owner, err := database.GetRoleByID(ctx, 1)
	if err != nil || owner == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	var buf bytes.Buffer
	if err := hub.WriteReadyForTest(database, user.ID, owner, &buf); err != nil {
		t.Fatalf("WriteReadyForTest: %v", err)
	}
	if rp.reads != 1 {
		t.Errorf("snapshot reads = %d, want exactly 1", rp.reads)
	}
	byID := readyChannelsByID(t, buf.Bytes())
	if ch, ok := byID[keepID]; !ok || ch["private"] != true {
		t.Errorf("surviving private channel = %v (present %v), want private=true", ch, ok)
	}
}

func recvChannelCreatePrivate(t *testing.T, send chan []byte, chID int64) any {
	t.Helper()
	p, _ := drainForMsgType(t, send, "channel_create")["payload"].(map[string]any)
	if id, _ := p["id"].(float64); int64(id) != chID {
		t.Fatalf("channel_create id = %v, want %d", p["id"], chID)
	}
	return p["private"]
}

// BroadcastChannelCreate carries private=true for a channel the default role
// cannot read (the moderator, who can, receives the frame).
func TestBroadcastChannelCreate_CarriesPrivateFlag(t *testing.T) {
	f := newAffordanceFixture(t, true)
	chID := seedTestChannel(t, f.database, "private-new-room")
	denyDefaultRoleRead(t, f.database, chID)
	ch, err := f.database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	f.hub.BroadcastChannelCreate(ch)
	if got := recvChannelCreatePrivate(t, f.modSend, chID); got != true {
		t.Errorf("BroadcastChannelCreate private = %v, want true", got)
	}
}

// The timeout refresh (NotifyModAction -> RefreshUserChannels) re-sends each
// visible channel with its private flag.
func TestNotifyModAction_TimeoutRefreshCarriesPrivateFlag(t *testing.T) {
	f := newAffordanceFixture(t, true)
	denyDefaultRoleRead(t, f.database, f.ch.ID)
	f.hub.NotifyModAction(f.modID, 1, "timeout", "test", nil)
	if got := recvChannelCreatePrivate(t, f.modSend, f.ch.ID); got != true {
		t.Errorf("timeout refresh channel_create private = %v, want true", got)
	}
}

// failingPrivacy errors every read.
type failingPrivacy struct{}

func (failingPrivacy) Snapshot(context.Context) (service.ChannelPrivacySnapshot, error) {
	return service.ChannelPrivacySnapshot{}, errors.New("snapshot failed")
}

func (failingPrivacy) ChannelIsPrivate(context.Context, int64) (bool, error) {
	return false, errors.New("read failed")
}

// A failed read must not fail ready or a frame: everything is private=false.
func TestBuildReady_PrivacyReadFailureIsNotPrivate(t *testing.T) {
	database := openCoverageDB(t)
	hub := newTestHubWith(t, ws.HubOptions{DB: database, ChannelPrivacy: failingPrivacy{}})
	user := seedCoverageOwner(t, database, "private-bulkfail")
	id, _ := database.CreateChannel(context.Background(), "locked", "text", "", "", 0)
	denyDefaultRoleRead(t, database, id)
	owner, err := database.GetRoleByID(context.Background(), 1)
	if err != nil || owner == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	var buf bytes.Buffer
	if err := hub.WriteReadyForTest(database, user.ID, owner, &buf); err != nil {
		t.Fatalf("ready failed on privacy read error: %v", err)
	}
	byID := readyChannelsByID(t, buf.Bytes())
	if len(byID) == 0 {
		t.Fatal("no channels in ready")
	}
	for cid, ch := range byID {
		if ch["private"] != false {
			t.Errorf("channel %d private = %v, want false", cid, ch["private"])
		}
	}
}
