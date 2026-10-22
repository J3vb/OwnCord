package ws

// forum_features_internal_test.go — WP 6.9d-a1: a client declares `features`
// in its auth frame, and a socket that did not declare "forums" is sent no
// forum row (ready and both per-recipient channel_create paths), while the
// shared channel_update stays shared so no sequence number is allocated and
// withheld.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

func TestParseClientFeatures(t *testing.T) {
	long := strings.Repeat("f", maxAuthFeatureLen+1)
	many := make([]string, 0, maxAuthFeatures+2)
	for range maxAuthFeatures {
		many = append(many, "noise")
	}
	many = append(many, featureForums)

	cases := []struct {
		name string
		in   []string
		want bool
	}{
		{"absent", nil, false},
		{"empty", []string{}, false},
		{"forums", []string{"forums"}, true},
		{"forums among unknown", []string{"threads", "forums", "z"}, true},
		{"unknown only", []string{"threads"}, false},
		{"case matters", []string{"Forums"}, false},
		{"oversized name is ignored", []string{long}, false},
		{"past the list cap is ignored", many, false},
	}
	for _, c := range cases {
		if got := parseClientFeatures(c.in).forums; got != c.want {
			t.Errorf("%s: forums = %v, want %v", c.name, got, c.want)
		}
	}
}

type forumWSFixture struct {
	hub         *Hub
	database    *db.DB
	srvURL      string
	oldTok      string
	newTok      string
	textID      int64
	forumID     int64
	oldUID, new int64
}

func newForumWSFixture(t *testing.T) *forumWSFixture {
	t.Helper()
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	f := &forumWSFixture{database: database}
	var err error
	if f.oldUID, err = database.CreateUser(ctx, "old-client", "hash", 1); err != nil {
		t.Fatal(err)
	}
	if f.new, err = database.CreateUser(ctx, "new-client", "hash", 1); err != nil {
		t.Fatal(err)
	}
	for uid, dst := range map[int64]*string{f.oldUID: &f.oldTok, f.new: &f.newTok} {
		tok, err := auth.GenerateToken()
		if err != nil {
			t.Fatal(err)
		}
		*dst = tok
		if _, err := database.CreateSession(ctx, uid, auth.HashToken(tok), "test", "127.0.0.1"); err != nil {
			t.Fatal(err)
		}
	}
	if f.textID, err = database.CreateChannel(ctx, "general", "text", "", "", 0); err != nil {
		t.Fatal(err)
	}
	if f.forumID, err = database.CreateChannel(ctx, "ideas", "forum", "", "", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ReplaceForumSettings(ctx, f.forumID, db.ForumSettingsWrite{
		RequireTag: true, DefaultAutoArchiveMinutes: 1440,
		Tags: []db.ForumTagWrite{{Name: "bug", Emoji: "🐛"}, {Name: "idea"}},
	}); err != nil {
		t.Fatal(err)
	}
	f.hub = newTestHub(t, database, auth.NewRateLimiter(), nil)
	go f.hub.Run()
	t.Cleanup(f.hub.Stop)
	srv := httptest.NewServer(ServeWS(f.hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	f.srvURL = srv.URL
	return f
}

// dial connects with the given auth payload extras and returns the connection
// after auth_ok and ready, plus the ready's channels by id.
func (f *forumWSFixture) dial(t *testing.T, token string, features []string) (*websocket.Conn, map[int64]map[string]any) {
	t.Helper()
	ctx := context.Background()
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(f.srvURL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	payload := map[string]any{"token": token, "last_seq": 0}
	if features != nil {
		payload["features"] = features
	}
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": payload})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok, got %q", typ)
	}
	typ, ready := readFrameType(t, ctx, conn)
	if typ != MsgTypeReady {
		t.Fatalf("expected ready, got %q", typ)
	}
	var env struct {
		Payload struct {
			Channels []map[string]any `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(ready, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	byID := map[int64]map[string]any{}
	for _, ch := range env.Payload.Channels {
		id, _ := ch["id"].(float64)
		byID[int64(id)] = ch
	}
	return conn, byID
}

// forumFrame is what the tests read from a pushed frame.
type forumFrame struct {
	Type      string
	ChannelID int64
	Seq       float64
	Forum     map[string]any
}

// collectForumFrames reads frames until a channel_create or channel_update for stopAt
// arrives, and returns every channel_create/channel_update/channel_delete
// seen on the way (in order, stopAt's included).
func collectForumFrames(t *testing.T, conn *websocket.Conn, stopAt int64, stopType string) []forumFrame {
	t.Helper()
	var out []forumFrame
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, raw, err := conn.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read: %v (saw %+v)", err, out)
		}
		var env struct {
			Type    string  `json:"type"`
			Seq     float64 `json:"seq"`
			Payload struct {
				ID    float64        `json:"id"`
				Forum map[string]any `json:"forum"`
			} `json:"payload"`
		}
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		switch env.Type {
		case MsgTypeChannelCreate, MsgTypeChannelUpdate, MsgTypeChannelDelete:
			s := forumFrame{Type: env.Type, ChannelID: int64(env.Payload.ID), Seq: env.Seq, Forum: env.Payload.Forum}
			out = append(out, s)
			if s.ChannelID == stopAt && s.Type == stopType {
				return out
			}
		}
	}
	t.Fatalf("timed out waiting for %s of channel %d (saw %+v)", stopType, stopAt, out)
	return nil
}

func hasForumFrame(frames []forumFrame, typ string, channelID int64) bool {
	return slices.ContainsFunc(frames, func(f forumFrame) bool { return f.Type == typ && f.ChannelID == channelID })
}

func TestForumsHiddenFromClientsWithoutTheFeature(t *testing.T) {
	f := newForumWSFixture(t)
	oldConn, oldReady := f.dial(t, f.oldTok, nil)
	newConn, newReady := f.dial(t, f.newTok, []string{"forums", "unknown-feature"})

	// ready: the old socket gets the text channel and no forum row.
	if _, ok := oldReady[f.textID]; !ok {
		t.Error("old client: the text channel is missing from ready")
	}
	if _, ok := oldReady[f.forumID]; ok {
		t.Error("old client: ready carries the forum row")
	}
	forum, ok := newReady[f.forumID]
	if !ok {
		t.Fatal("new client: ready lacks the forum")
	}
	if forum["type"] != "forum" || forum["can_send"] != true {
		t.Errorf("forum row = type %v can_send %v, want forum and true", forum["type"], forum["can_send"])
	}
	if _, has := forum["unread_count"]; has {
		t.Error("a forum row carries unread state")
	}
	settings, _ := forum["forum"].(map[string]any)
	tags, _ := settings["tags"].([]any)
	if settings["require_tag"] != true || settings["default_auto_archive_minutes"] != float64(1440) || len(tags) != 2 {
		t.Fatalf("forum settings = %v", settings)
	}
	if first, _ := tags[0].(map[string]any); first["name"] != "bug" || first["emoji"] != "🐛" || first["position"] != float64(0) || first["id"] == nil {
		t.Errorf("first tag = %v", tags[0])
	}
	if _, has := newReady[f.textID]["forum"]; has {
		t.Error("a text channel carries forum settings")
	}

	// BroadcastChannelCreate: a second forum, then a sentinel text channel.
	ctx := context.Background()
	forum2, err := f.database.CreateChannel(ctx, "later", "forum", "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	sentinel, err := f.database.CreateChannel(ctx, "sentinel", "text", "", "", 3)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{forum2, sentinel} {
		ch, err := f.database.GetChannel(ctx, id)
		if err != nil || ch == nil {
			t.Fatalf("GetChannel(%d): %v", id, err)
		}
		f.hub.BroadcastChannelCreate(ch)
	}
	if got := collectForumFrames(t, oldConn, sentinel, MsgTypeChannelCreate); hasForumFrame(got, MsgTypeChannelCreate, forum2) {
		t.Errorf("old client was sent the new forum's channel_create: %+v", got)
	}
	got := collectForumFrames(t, newConn, sentinel, MsgTypeChannelCreate)
	if !hasForumFrame(got, MsgTypeChannelCreate, forum2) {
		t.Errorf("new client missed the forum's channel_create: %+v", got)
	}
	for _, fr := range got {
		if fr.ChannelID == forum2 && (fr.Forum == nil || fr.Forum["tags"] == nil) {
			t.Errorf("forum channel_create carries no settings: %+v", fr)
		}
	}

	// RefreshChannelVisibility (the override-change path): the same filter.
	forumCh, err := f.database.GetChannel(ctx, f.forumID)
	if err != nil || forumCh == nil {
		t.Fatal(err)
	}
	f.hub.RefreshChannelVisibility(forumCh)
	textCh, _ := f.database.GetChannel(ctx, f.textID)
	f.hub.RefreshChannelVisibility(textCh)
	if got := collectForumFrames(t, oldConn, f.textID, MsgTypeChannelCreate); hasForumFrame(got, MsgTypeChannelCreate, f.forumID) || hasForumFrame(got, MsgTypeChannelDelete, f.forumID) {
		t.Errorf("old client was sent a frame for the forum on a visibility refresh: %+v", got)
	}
	if got := collectForumFrames(t, newConn, f.textID, MsgTypeChannelCreate); !hasForumFrame(got, MsgTypeChannelCreate, f.forumID) {
		t.Errorf("new client missed the forum on a visibility refresh: %+v", got)
	}
}

// channel_update is one shared sequenced frame: filtering it per client would
// allocate a sequence number and withhold it. Both sockets get the forum's
// update, and the old one sees an unbroken sequence around it.
func TestForumChannelUpdateStaysShared(t *testing.T) {
	f := newForumWSFixture(t)
	oldConn, _ := f.dial(t, f.oldTok, nil)
	newConn, _ := f.dial(t, f.newTok, []string{"forums"})
	ctx := context.Background()

	textCh, _ := f.database.GetChannel(ctx, f.textID)
	forumCh, _ := f.database.GetChannel(ctx, f.forumID)
	f.hub.BroadcastChannelUpdate(textCh)
	f.hub.BroadcastChannelUpdate(forumCh)
	f.hub.BroadcastChannelUpdate(textCh)

	read := func(conn *websocket.Conn) []forumFrame {
		all := make([]forumFrame, 0, 3)
		for range 3 {
			all = append(all, nextForumFrame(t, conn, MsgTypeChannelUpdate)...)
		}
		return all
	}
	oldSeen, newSeen := read(oldConn), read(newConn)
	for name, seen := range map[string][]forumFrame{"old": oldSeen, "new": newSeen} {
		if len(seen) != 3 || seen[1].ChannelID != f.forumID {
			t.Fatalf("%s client saw %+v, want the three updates with the forum's in the middle", name, seen)
		}
		if seen[0].Seq == 0 || seen[1].Seq != seen[0].Seq+1 || seen[2].Seq != seen[1].Seq+1 {
			t.Errorf("%s client's sequence is not contiguous across the forum update: %+v", name, seen)
		}
		if seen[1].Forum == nil || seen[1].Forum["require_tag"] != true {
			t.Errorf("%s client's forum update carries no settings: %+v", name, seen[1])
		}
	}
	for i := range oldSeen {
		if oldSeen[i].Seq != newSeen[i].Seq {
			t.Errorf("frame %d: old seq %v, new seq %v, want one shared frame", i, oldSeen[i].Seq, newSeen[i].Seq)
		}
	}
}

// nextForumFrame reads frames until one of the given type arrives.
func nextForumFrame(t *testing.T, conn *websocket.Conn, typ string) []forumFrame {
	t.Helper()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, raw, err := conn.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var env struct {
			Type    string  `json:"type"`
			Seq     float64 `json:"seq"`
			Payload struct {
				ID    float64        `json:"id"`
				Forum map[string]any `json:"forum"`
			} `json:"payload"`
		}
		if json.Unmarshal(raw, &env) == nil && env.Type == typ {
			return []forumFrame{{Type: env.Type, ChannelID: int64(env.Payload.ID), Seq: env.Seq, Forum: env.Payload.Forum}}
		}
	}
}

// The two other per-recipient channel_create senders — a timeout refresh
// (RefreshUserChannels) and a role refresh (EnqueueRoleRefresh) — apply the
// same filter. A sentinel text channel at the last position marks the end of
// each pass.
func TestForumsHiddenOnTimeoutAndRoleRefresh(t *testing.T) {
	f := newForumWSFixture(t)
	oldConn, _ := f.dial(t, f.oldTok, nil)
	newConn, _ := f.dial(t, f.newTok, []string{"forums"})
	sentinel, err := f.database.CreateChannel(context.Background(), "sentinel", "text", "", "", 99)
	if err != nil {
		t.Fatal(err)
	}

	f.hub.RefreshUserChannels(f.oldUID)
	f.hub.RefreshUserChannels(f.new)
	if got := collectForumFrames(t, oldConn, sentinel, MsgTypeChannelCreate); hasForumFrame(got, MsgTypeChannelCreate, f.forumID) || !hasForumFrame(got, MsgTypeChannelCreate, f.textID) {
		t.Errorf("timeout refresh, old client saw %+v, want the text channel and no forum", got)
	}
	if got := collectForumFrames(t, newConn, sentinel, MsgTypeChannelCreate); !hasForumFrame(got, MsgTypeChannelCreate, f.forumID) {
		t.Errorf("timeout refresh, new client saw %+v, want the forum too", got)
	}

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{f.oldUID, f.new}})
	if got := collectForumFrames(t, oldConn, sentinel, MsgTypeChannelCreate); hasForumFrame(got, MsgTypeChannelCreate, f.forumID) || !hasForumFrame(got, MsgTypeChannelCreate, f.textID) {
		t.Errorf("role refresh, old client saw %+v, want the text channel and no forum", got)
	}
	if got := collectForumFrames(t, newConn, sentinel, MsgTypeChannelCreate); !hasForumFrame(got, MsgTypeChannelCreate, f.forumID) {
		t.Errorf("role refresh, new client saw %+v, want the forum too", got)
	}
}
