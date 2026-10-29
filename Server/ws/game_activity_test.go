package ws

// game_activity_test.go — WP 8.3a: the activity_update frame and the game
// activity carried on presence, presence_batch and ready.activities. The
// activity is memory only, lives on the connection's livePresence, and every
// presence frame carries the current value.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

func TestActivityUpdate_Parse(t *testing.T) {
	ctor, ok := getCommandConstructor(MsgTypeActivityUpdate)
	if !ok {
		t.Fatal("no activity_update constructor")
	}
	long128 := strings.Repeat("a", 128)
	long129 := strings.Repeat("a", 129)
	cases := []struct {
		name      string
		payload   string
		wantErr   bool
		wantClear bool
		wantName  string
		wantAt    int64
	}{
		{"set", `{"activity":{"name":"Factorio","started_at":1700000000000}}`, false, false, "Factorio", 1700000000000},
		{"name is trimmed", `{"activity":{"name":"  Factorio \t","started_at":5}}`, false, false, "Factorio", 5},
		{"inner spaces collapse like custom_status", `{"activity":{"name":"Deep   Rock","started_at":5}}`, false, false, "Deep Rock", 5},
		{"128 chars", `{"activity":{"name":"` + long128 + `","started_at":5}}`, false, false, long128, 5},
		{"129 chars", `{"activity":{"name":"` + long129 + `","started_at":5}}`, true, false, "", 0},
		{"line break", `{"activity":{"name":"a\nb","started_at":5}}`, true, false, "", 0},
		{"control char", `{"activity":{"name":"a\u0007b","started_at":5}}`, true, false, "", 0},
		{"invisible filler", `{"activity":{"name":"aㅤb","started_at":5}}`, true, false, "", 0},
		{"bidi override", `{"activity":{"name":"a\u202eb","started_at":5}}`, true, false, "", 0},
		{"empty name clears", `{"activity":{"name":"","started_at":5}}`, false, true, "", 0},
		{"blank name clears", `{"activity":{"name":"   ","started_at":5}}`, false, true, "", 0},
		{"null clears", `{"activity":null}`, false, true, "", 0},
		{"missing activity", `{}`, true, false, "", 0},
		{"activity is a string", `{"activity":"Factorio"}`, true, false, "", 0},
		{"activity is an array", `{"activity":[]}`, true, false, "", 0},
		{"name is a number", `{"activity":{"name":7,"started_at":5}}`, true, false, "", 0},
		{"name missing", `{"activity":{"started_at":5}}`, true, false, "", 0},
		{"started_at is a string", `{"activity":{"name":"x","started_at":"5"}}`, true, false, "", 0},
		{"started_at is a fraction", `{"activity":{"name":"x","started_at":5.5}}`, true, false, "", 0},
		{"started_at is null", `{"activity":{"name":"x","started_at":null}}`, true, false, "", 0},
		{"started_at missing", `{"activity":{"name":"x"}}`, true, false, "", 0},
		{"payload not an object", `[]`, true, false, "", 0},
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
		got := cmd.(ActivityUpdateCmd)
		if got.Clear != tc.wantClear || got.Name != tc.wantName || got.StartedAt != tc.wantAt {
			t.Errorf("%s: cmd = %+v, want clear=%v name=%q started_at=%d", tc.name, got, tc.wantClear, tc.wantName, tc.wantAt)
		}
	}
}

// A bad payload reaches the client as BAD_REQUEST, through the real frame path.
func TestActivityUpdate_BadPayloadAnswersBadRequest(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	c := connect("badpayload", true)
	for _, payload := range []string{
		`{"activity":{"name":"` + strings.Repeat("a", 129) + `","started_at":5}}`,
		`{"activity":{"name":"a\nb","started_at":5}}`,
		`{"activity":{"name":7,"started_at":5}}`,
		`{"activity":{"name":"x","started_at":"5"}}`,
	} {
		h.handleMessage(c, []byte(`{"type":"activity_update","id":"r1","payload":`+payload+`}`))
		frames := drain(c.send)
		if len(frames) != 1 || activityErrCode(t, frames[0]) != ErrCodeBadRequest {
			t.Fatalf("payload %s: frames = %q, want one BAD_REQUEST", payload, frames)
		}
	}
	if c.livePresence().activity != nil {
		t.Fatal("a rejected frame changed the live activity")
	}
}

func activityErrCode(t *testing.T, raw []byte) string {
	t.Helper()
	var f struct {
		Type    string `json:"type"`
		Payload struct {
			Code string `json:"code"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("frame %s: %v", raw, err)
	}
	if f.Type != MsgTypeError {
		return "(" + f.Type + ")"
	}
	return f.Payload.Code
}

func TestActivityUpdate_StartedAtClampedToLast24Hours(t *testing.T) {
	deps := PresenceDeps{Limiter: auth.NewRateLimiter()}
	info := ClientInfo{UserID: 1}
	run := func(startedAt int64) int64 {
		t.Helper()
		// A fresh limiter per call: only the clamp is under test.
		deps.Limiter = auth.NewRateLimiter()
		res := handleActivityUpdateV2(context.Background(),
			ActivityUpdateCmd{userID: 1, Name: "Factorio", StartedAt: startedAt}, info, deps)
		if res.Error != nil || res.SetActivity == nil || res.SetActivity.next == nil {
			t.Fatalf("result = %+v, want an activity", res)
		}
		return res.SetActivity.next.StartedAt
	}
	before := time.Now().UnixMilli()
	day := (24 * time.Hour).Milliseconds()

	if got := run(1); got < before-day || got > time.Now().UnixMilli()-day+1000 {
		t.Errorf("ancient started_at clamped to %d, want about now-24h", got)
	}
	if got := run(before + 10*day); got < before || got > time.Now().UnixMilli() {
		t.Errorf("future started_at clamped to %d, want about now", got)
	}
	inRange := before - 3600_000
	if got := run(inRange); got != inRange {
		t.Errorf("in-range started_at = %d, want %d unchanged", got, inRange)
	}
}

// ---------------------------------------------------------------------------
// Rate limit, clear and no-op rules (handler level)
// ---------------------------------------------------------------------------

func TestActivityUpdate_RateLimitAndClearRules(t *testing.T) {
	ctx := context.Background()
	limiter := auth.NewRateLimiter()
	deps := PresenceDeps{Limiter: limiter}
	now := time.Now().UnixMilli()
	set := func(name string, cur *gameActivity) Result {
		return handleActivityUpdateV2(ctx, ActivityUpdateCmd{userID: 1, Name: name, StartedAt: now}, ClientInfo{UserID: 1, Activity: cur}, deps)
	}
	clear := func(cur *gameActivity) Result {
		return handleActivityUpdateV2(ctx, ActivityUpdateCmd{userID: 1, Clear: true}, ClientInfo{UserID: 1, Activity: cur}, deps)
	}

	first := set("Factorio", nil)
	if first.Error != nil || first.SetActivity == nil || first.SetActivity.next == nil {
		t.Fatalf("first set = %+v, want it applied", first)
	}
	cur := first.SetActivity.next

	// A second, different set inside 10 s is refused.
	second := set("Satisfactory", cur)
	ce, ok := errors.AsType[ClientError](second.Error)
	if !ok || ce.Code != ErrCodeRateLimited || second.SetActivity != nil {
		t.Fatalf("second set = %+v, want RATE_LIMITED and no change", second)
	}

	// A clear is never limited, however often it removes something.
	for i := range 3 {
		res := clear(cur)
		if res.Error != nil || res.SetActivity == nil || res.SetActivity.next != nil {
			t.Fatalf("clear #%d = %+v, want a clear that was not limited", i, res)
		}
	}

	// A clear with nothing set does nothing: no change to apply, so nothing to broadcast.
	if res := clear(nil); res.Error != nil || res.SetActivity != nil || len(res.Events) != 0 {
		t.Fatalf("clear with nothing set = %+v, want an empty result", res)
	}
}

func TestActivityUpdate_IdenticalActivityIsNoOpAndSpendsNoBudget(t *testing.T) {
	ctx := context.Background()
	deps := PresenceDeps{Limiter: auth.NewRateLimiter()}
	at := time.Now().UnixMilli() - 5000
	cur := &gameActivity{Name: "Factorio", StartedAt: at}

	res := handleActivityUpdateV2(ctx, ActivityUpdateCmd{userID: 1, Name: "Factorio", StartedAt: at}, ClientInfo{UserID: 1, Activity: cur}, deps)
	if res.Error != nil || res.SetActivity != nil || len(res.Events) != 0 {
		t.Fatalf("identical set = %+v, want an empty result", res)
	}
	// Same game, another start (a re-send after reconnect, or a session past
	// the 24 h clamp): still a no-op, and the shown start is kept.
	res = handleActivityUpdateV2(ctx, ActivityUpdateCmd{userID: 1, Name: "Factorio", StartedAt: at + 60_000}, ClientInfo{UserID: 1, Activity: cur}, deps)
	if res.Error != nil || res.SetActivity != nil || len(res.Events) != 0 {
		t.Fatalf("same game, new start = %+v, want an empty result", res)
	}
	old := &gameActivity{Name: "Factorio", StartedAt: time.Now().Add(-30 * time.Hour).UnixMilli()}
	res = handleActivityUpdateV2(ctx, ActivityUpdateCmd{userID: 1, Name: "Factorio", StartedAt: old.StartedAt}, ClientInfo{UserID: 1, Activity: old}, deps)
	if res.Error != nil || res.SetActivity != nil {
		t.Fatalf("same game past the clamp = %+v, want an empty result", res)
	}
	// The no-op took no budget, so a real change right after is allowed.
	res = handleActivityUpdateV2(ctx, ActivityUpdateCmd{userID: 1, Name: "Satisfactory", StartedAt: at}, ClientInfo{UserID: 1, Activity: cur}, deps)
	if res.Error != nil || res.SetActivity == nil {
		t.Fatalf("change after a no-op = %+v, want it applied", res)
	}
}

// ---------------------------------------------------------------------------
// Broadcast behaviour through the hub
// ---------------------------------------------------------------------------

type actFrame struct {
	Type    string `json:"type"`
	Payload struct {
		UserID       int64           `json:"user_id"`
		Status       string          `json:"status"`
		CustomStatus *string         `json:"custom_status"`
		Activity     json.RawMessage `json:"activity"`
		Updates      []struct {
			UserID       int64           `json:"user_id"`
			Status       string          `json:"status"`
			CustomStatus *string         `json:"custom_status"`
			Activity     json.RawMessage `json:"activity"`
		} `json:"updates"`
		Full bool `json:"full"`
	} `json:"payload"`
}

// activityName decodes an "activity" value: its name, "" for null, and
// absent=true when the key was missing altogether.
func activityName(t *testing.T, raw json.RawMessage) (name string, absent bool) {
	t.Helper()
	if raw == nil {
		return "", true
	}
	if string(raw) == "null" {
		return "", false
	}
	var a struct {
		Name      string `json:"name"`
		StartedAt int64  `json:"started_at"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatalf("activity %s: %v", raw, err)
	}
	return a.Name, false
}

// presenceFramesOf returns the presence frames about userID among c's queued
// frames, in order, as the activity name each carries ("" for null). It fails
// the test if a frame omits the key.
func presenceFramesOf(t *testing.T, c *Client, userID int64) (names []string, statuses []string) {
	t.Helper()
	for _, raw := range drain(c.send) {
		var f actFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("frame %s: %v", raw, err)
		}
		if f.Type != MsgTypePresence || f.Payload.UserID != userID {
			continue
		}
		name, absent := activityName(t, f.Payload.Activity)
		if absent {
			t.Fatalf("presence frame %s has no activity key", raw)
		}
		names = append(names, name)
		statuses = append(statuses, f.Payload.Status)
	}
	return names, statuses
}

func sendActivity(t *testing.T, h *Hub, c *Client, name string) {
	t.Helper()
	body := `{"type":"activity_update","payload":{"activity":null}}`
	if name != "" {
		body = `{"type":"activity_update","payload":{"activity":{"name":"` + name + `","started_at":` +
			activityItoa(time.Now().UnixMilli()-1000) + `}}}`
	}
	h.handleMessage(c, []byte(body))
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func activityItoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestActivityUpdate_BroadcastsPresenceWithTheLiveStatus(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	player := connect("player", true)
	watcher := connect("watcher", true)
	text := "afk soon"
	player.setLivePresence(db.StatusDND, &text, "")
	drain(player.send)
	drain(watcher.send)

	sendActivity(t, h, player, "Factorio")

	names, statuses := presenceFramesOf(t, watcher, player.userID)
	if len(names) != 1 || names[0] != "Factorio" || statuses[0] != db.StatusDND {
		t.Fatalf("watcher saw %v / %v, want one dnd presence carrying Factorio", names, statuses)
	}
	if lp := player.livePresence(); lp.activity == nil || lp.activity.Name != "Factorio" || lp.status != db.StatusDND || lp.customStatus == nil || *lp.customStatus != text {
		t.Fatalf("live presence = %+v, want the activity set and status/text kept", lp)
	}
	// The wire frame also keeps the custom status.
	// (checked on a second set below, after the budget window is reset)
	h.limiter.Reset(context.Background(), auth.Key("activity", player.userID))
	sendActivity(t, h, player, "Satisfactory")
	for _, raw := range drain(watcher.send) {
		var f actFrame
		_ = json.Unmarshal(raw, &f)
		if f.Type == MsgTypePresence && f.Payload.UserID == player.userID {
			if f.Payload.CustomStatus == nil || *f.Payload.CustomStatus != text {
				t.Fatalf("activity frame custom_status = %v, want %q", f.Payload.CustomStatus, text)
			}
		}
	}
}

func TestActivityUpdate_ClearAndNoOpBroadcastRules(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	player := connect("clearer", true)
	watcher := connect("clearwatch", true)
	drain(player.send)
	drain(watcher.send)

	// A clear with nothing set broadcasts nothing and answers nothing.
	sendActivity(t, h, player, "")
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("clear with nothing set broadcast %q", frames)
	}
	if frames := drain(player.send); len(frames) != 0 {
		t.Fatalf("clear with nothing set answered %q", frames)
	}

	sendActivity(t, h, player, "Factorio")
	if names, _ := presenceFramesOf(t, watcher, player.userID); len(names) != 1 {
		t.Fatalf("set broadcast %v, want one frame", names)
	}
	drain(player.send)

	// The same activity again (the client's poll): no frame, no error. Pin
	// started_at so the two frames are identical.
	at := player.livePresence().activity.StartedAt
	same := []byte(`{"type":"activity_update","payload":{"activity":{"name":"Factorio","started_at":` + activityItoa(at) + `}}}`)
	h.handleMessage(player, same)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("identical activity broadcast %q", frames)
	}
	if frames := drain(player.send); len(frames) != 0 {
		t.Fatalf("identical activity answered %q", frames)
	}

	// A different activity inside the window is refused with RATE_LIMITED
	// and changes nothing.
	sendActivity(t, h, player, "Satisfactory")
	own := drain(player.send)
	if len(own) != 1 || activityErrCode(t, own[0]) != ErrCodeRateLimited {
		t.Fatalf("second set answered %q, want RATE_LIMITED", own)
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("a refused set broadcast %q", frames)
	}
	if a := player.livePresence().activity; a == nil || a.Name != "Factorio" {
		t.Fatalf("activity after a refused set = %+v, want Factorio", a)
	}

	// A clear is never limited and does broadcast the null.
	sendActivity(t, h, player, "")
	names, _ := presenceFramesOf(t, watcher, player.userID)
	if len(names) != 1 || names[0] != "" {
		t.Fatalf("clear broadcast %v, want one null activity", names)
	}
	if player.livePresence().activity != nil {
		t.Fatal("clear left the activity set")
	}
}

// Edge case 1: a replacement connection starts empty; the replaced
// connection's late activity_update and its disconnect do not touch it.
func TestActivityUpdate_ReplacedConnectionCannotTouchTheNewOne(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	ctx := context.Background()
	old := connect("replaced", true)
	watcher := connect("replwatch", true)
	sendActivity(t, h, old, "Factorio")
	drain(old.send)
	drain(watcher.send)

	// The same user reconnects: the new connection holds the slot and starts
	// with no activity.
	u, err := database.GetUserByID(ctx, old.userID)
	if err != nil {
		t.Fatal(err)
	}
	fresh := herdClient(ctx, h, u)
	h.registerNowTest(fresh, nil)
	fresh.user.Status = db.StatusOnline
	fresh.setLivePresence(db.StatusOnline, nil, "")
	if fresh.livePresence().activity != nil {
		t.Fatal("a replacement connection did not start empty")
	}
	drain(watcher.send)

	// The replaced connection's late set changes nothing and says nothing.
	h.limiter.Reset(ctx, auth.Key("activity", old.userID))
	sendActivity(t, h, old, "Satisfactory")
	if a := fresh.livePresence().activity; a != nil {
		t.Fatalf("the replaced connection's late set reached the new one: %+v", a)
	}
	if names, _ := presenceFramesOf(t, watcher, old.userID); len(names) != 0 {
		t.Fatalf("the replaced connection's late set broadcast %v", names)
	}
	// The kick may already have shut the old socket's frame path, so apply a
	// late change the way a frame that raced the replacement would.
	h.applyActivity(old, &gameActivity{Name: "Late Game", StartedAt: time.Now().UnixMilli()})
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	if a := fresh.livePresence().activity; a != nil {
		t.Fatalf("a racing apply from the replaced connection reached the new one: %+v", a)
	}
	if names, _ := presenceFramesOf(t, watcher, old.userID); len(names) != 0 {
		t.Fatalf("a racing apply from the replaced connection broadcast %v", names)
	}

	// The new connection sets its own; the replaced one then disconnects.
	h.limiter.Reset(ctx, auth.Key("activity", old.userID))
	sendActivity(t, h, fresh, "Deep Rock")
	drain(watcher.send)
	if replaced := h.unregisterNow(old); !replaced {
		t.Fatal("unregisterNow did not report a replacement")
	}
	if h.shouldMarkOffline(old, true) {
		t.Fatal("the replaced connection's disconnect would mark the user offline")
	}
	if a := fresh.livePresence().activity; a == nil || a.Name != "Deep Rock" {
		t.Fatalf("the new connection's activity after the old one left = %+v, want Deep Rock", a)
	}
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	if names, _ := presenceFramesOf(t, watcher, old.userID); len(names) != 0 {
		t.Fatalf("the replaced connection's disconnect broadcast %v", names)
	}
}

// A real disconnect drops the activity with the connection: the offline
// presence the others get carries null.
func TestActivityUpdate_DisconnectClearsIt(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	player := connect("leaver", true)
	watcher := connect("leavewatch", true)
	sendActivity(t, h, player, "Factorio")
	drain(watcher.send)

	if replaced := h.unregisterNow(player); replaced {
		t.Fatal("a plain disconnect was reported as a replacement")
	}
	h.QueuePresence(player.userID, db.StatusOffline, nil)
	settle(t, h)
	var sawOffline bool
	for _, raw := range drain(watcher.send) {
		var f actFrame
		_ = json.Unmarshal(raw, &f)
		if f.Type != MsgTypePresenceBatch {
			continue
		}
		for _, e := range f.Payload.Updates {
			if e.UserID != player.userID {
				continue
			}
			sawOffline = true
			if name, absent := activityName(t, e.Activity); absent || name != "" {
				t.Fatalf("offline entry activity = %s, want null", e.Activity)
			}
		}
	}
	if !sawOffline {
		t.Fatal("no offline entry for the disconnected player")
	}
}

// Edge case 2: a status change, a custom status expiry and an idle flip keep
// the activity on every presence frame; invisible blanks it for others but
// not for self; back to online shows it again.
func TestActivity_SurvivesStatusChangesAndInvisibleHidesIt(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	player := connect("statuser", true)
	watcher := connect("statwatch", true)
	sendActivity(t, h, player, "Factorio")
	drain(player.send)
	drain(watcher.send)
	uid := player.userID
	key := auth.Key("presence", uid)

	setStatus := func(payload string) {
		t.Helper()
		h.limiter.Reset(context.Background(), key)
		h.handleMessage(player, []byte(`{"type":"presence_update","payload":`+payload+`}`))
		if err := h.awaitDispatch(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	wantOne := func(c *Client, what, wantStatus, wantActivity string) {
		t.Helper()
		names, statuses := presenceFramesOf(t, c, uid)
		if len(names) != 1 || names[0] != wantActivity || statuses[0] != wantStatus {
			t.Fatalf("%s: frames = %v / %v, want one %s presence with activity %q", what, names, statuses, wantStatus, wantActivity)
		}
	}

	// dnd with an expiring custom status.
	setStatus(`{"status":"dnd","custom_status":"deep work","custom_status_expires_in":60}`)
	wantOne(watcher, "dnd watcher", db.StatusDND, "Factorio")
	wantOne(player, "dnd self", db.StatusDND, "Factorio")

	// The custom status expires.
	tag := player.livePresence().customStatusExpiresAt
	if tag == "" {
		t.Fatal("no expiry tag on the live presence")
	}
	h.CustomStatusExpired(uid, tag)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	wantOne(watcher, "expiry watcher", db.StatusDND, "Factorio")
	wantOne(player, "expiry self", db.StatusDND, "Factorio")
	if a := player.livePresence().activity; a == nil {
		t.Fatal("custom status expiry dropped the activity")
	}

	// Idle.
	setStatus(`{"status":"idle"}`)
	wantOne(watcher, "idle watcher", db.StatusIdle, "Factorio")
	wantOne(player, "idle self", db.StatusIdle, "Factorio")

	// Invisible: others see offline and no game; the player still sees theirs.
	setStatus(`{"status":"invisible"}`)
	wantOne(watcher, "invisible watcher", db.StatusOffline, "")
	wantOne(player, "invisible self", db.StatusInvisible, "Factorio")

	// A new activity while invisible reaches only the player.
	h.limiter.Reset(context.Background(), auth.Key("activity", uid))
	sendActivity(t, h, player, "Satisfactory")
	if names, _ := presenceFramesOf(t, watcher, uid); len(names) != 0 {
		t.Fatalf("invisible set watcher: frames = %v, want none", names)
	}
	wantOne(player, "invisible set self", db.StatusInvisible, "Satisfactory")

	// Back online shows it again.
	setStatus(`{"status":"online"}`)
	wantOne(watcher, "online watcher", db.StatusOnline, "Satisfactory")
	wantOne(player, "online self", db.StatusOnline, "Satisfactory")
}

// ---------------------------------------------------------------------------
// presence_batch snapshot, ready.activities, capability
// ---------------------------------------------------------------------------

func snapshotActivities(t *testing.T, c *Client) map[int64]string {
	t.Helper()
	var got map[int64]string
	for _, raw := range drain(c.send) {
		var f actFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("frame %s: %v", raw, err)
		}
		if f.Type != MsgTypePresenceBatch || !f.Payload.Full {
			continue
		}
		got = map[int64]string{}
		for _, e := range f.Payload.Updates {
			name, absent := activityName(t, e.Activity)
			if absent {
				t.Fatalf("snapshot entry for user %d has no activity key", e.UserID)
			}
			got[e.UserID] = name
		}
	}
	if got == nil {
		t.Fatalf("user %d got no full presence snapshot", c.userID)
	}
	return got
}

func TestPresenceSnapshot_CarriesActivityAndHidesInvisibleFromOthers(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	ctx := context.Background()
	observer := connect("snapobs", true)
	gamer := connect("snapgamer", true)
	ghost := connect("snapghost", true)
	idle := connect("snapnone", true)
	sendActivity(t, h, gamer, "Factorio")
	sendActivity(t, h, ghost, "Secret Game")
	ghost.setLivePresence(db.StatusInvisible, nil, "")
	settle(t, h)
	for _, c := range []*Client{observer, gamer, ghost, idle} {
		drain(c.send)
		c.presenceStale.Store(true)
	}
	h.enqueue(broadcastMsg{presenceSnapshot: true}, "presence snapshot")
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}

	seen := snapshotActivities(t, observer)
	if seen[gamer.userID] != "Factorio" {
		t.Errorf("observer sees gamer activity %q, want Factorio", seen[gamer.userID])
	}
	if name, listed := seen[idle.userID]; !listed || name != "" {
		t.Errorf("observer sees idle player as %q (listed=%v), want listed with null activity", name, listed)
	}
	if name, listed := seen[ghost.userID]; listed {
		t.Errorf("observer's snapshot lists the invisible user (activity %q)", name)
	}
	if own := snapshotActivities(t, ghost)[ghost.userID]; own != "Secret Game" {
		t.Errorf("the invisible user's own snapshot activity = %q, want Secret Game", own)
	}
}

func readyActivitiesFor(t *testing.T, h *Hub, database *db.DB, userID int64) []struct {
	UserID    int64  `json:"user_id"`
	Name      string `json:"name"`
	StartedAt int64  `json:"started_at"`
} {
	t.Helper()
	raw, err := h.readyBytes(database, userID, nil)
	if err != nil {
		t.Fatalf("readyBytes: %v", err)
	}
	var env struct {
		Payload struct {
			Activities []struct {
				UserID    int64  `json:"user_id"`
				Name      string `json:"name"`
				StartedAt int64  `json:"started_at"`
			} `json:"activities"`
			Capabilities map[string]any `json:"capabilities"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if env.Payload.Activities == nil {
		t.Fatalf("ready has no activities array: %s", raw[:min(len(raw), 300)])
	}
	if got, ok := env.Payload.Capabilities["game_activity"].(bool); !ok || !got {
		t.Errorf("capabilities.game_activity = %v, want true", env.Payload.Capabilities["game_activity"])
	}
	return env.Payload.Activities
}

func TestReady_ActivitiesAndCapability(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	viewer := connect("readyviewer", true)
	gamer := connect("readygamer", true)
	ghost := connect("readyghost", true)

	// Nobody is playing: the array is present and empty.
	if got := readyActivitiesFor(t, h, database, viewer.userID); len(got) != 0 {
		t.Fatalf("ready.activities = %+v, want empty", got)
	}

	sendActivity(t, h, gamer, "Factorio")
	sendActivity(t, h, ghost, "Secret Game")
	ghost.setLivePresence(db.StatusInvisible, nil, "")
	sendActivity(t, h, viewer, "Celeste")

	got := readyActivitiesFor(t, h, database, viewer.userID)
	byUser := map[int64]string{}
	for _, a := range got {
		byUser[a.UserID] = a.Name
		if a.StartedAt <= 0 {
			t.Errorf("activity for user %d has started_at %d", a.UserID, a.StartedAt)
		}
	}
	if byUser[gamer.userID] != "Factorio" || byUser[viewer.userID] != "Celeste" {
		t.Errorf("viewer's ready.activities = %v, want the gamer and the viewer's own", byUser)
	}
	if _, leaked := byUser[ghost.userID]; leaked {
		t.Errorf("ready.activities lists the invisible user to another viewer: %v", byUser)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].UserID >= got[i].UserID {
			t.Errorf("ready.activities not sorted by user_id: %+v", got)
		}
	}

	// The invisible user's own ready keeps their activity.
	own := map[int64]string{}
	for _, a := range readyActivitiesFor(t, h, database, ghost.userID) {
		own[a.UserID] = a.Name
	}
	if own[ghost.userID] != "Secret Game" {
		t.Errorf("the invisible user's own ready.activities = %v, want their game", own)
	}
}
