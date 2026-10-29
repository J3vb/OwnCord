package ws

// game_activity_policy_test.go — WP 8.3e-2: the per-server game activity
// switch. The setting is the admin's; the hub holds the flag the handlers, the
// presence emitters and ready read, clears every shown game when it goes off,
// and tells clients with the unsequenced game_activity_policy frame (auth_ok
// carries the same value on every connect and resume).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// saveGameActivitySwitch stores the setting the way the admin PATCH does and
// hands it to the hub, which re-reads the stored value.
func saveGameActivitySwitch(t *testing.T, h *Hub, database *db.DB, enabled bool) {
	t.Helper()
	if err := database.SetSetting(context.Background(), service.GameActivityEnabledKey, strconv.FormatBool(enabled)); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	h.ApplyGameActivityPolicy(enabled)
	// The sweep's clear rides the async broadcast FIFO: wait for it, or a
	// test that drains right after races the dispatch goroutine.
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
}

// policyFrames returns the game_activity_policy frames among c's queued
// frames, as the enabled value each carries, and fails on a sequenced one.
func policyFrames(t *testing.T, c *Client) []bool {
	t.Helper()
	var out []bool
	for _, raw := range drain(c.send) {
		var f struct {
			Type    string          `json:"type"`
			Seq     json.RawMessage `json:"seq"`
			Payload struct {
				Enabled *bool `json:"enabled"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("frame %s: %v", raw, err)
		}
		if f.Type != MsgTypeGameActivityPolicy {
			continue
		}
		if f.Seq != nil {
			t.Fatalf("game_activity_policy carries seq %s: %s", f.Seq, raw)
		}
		if f.Payload.Enabled == nil {
			t.Fatalf("game_activity_policy has no enabled: %s", raw)
		}
		out = append(out, *f.Payload.Enabled)
	}
	return out
}

func TestGameActivityPolicy_OffClearsEveryConnection(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	player := connect("gapplayer", true)
	ghost := connect("gapghost", true)
	watcher := connect("gapwatcher", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	sendActivity(t, h, player, "Factorio")
	sendActivity(t, h, ghost, "Secret Game")
	ghost.setLivePresence(db.StatusInvisible, nil, "")
	drain(player.send)
	drain(ghost.send)
	drain(watcher.send)

	saveGameActivitySwitch(t, h, database, false)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}

	if player.livePresence().activity != nil || ghost.livePresence().activity != nil {
		t.Fatal("switching off left a live activity")
	}
	// The visible user is cleared for everyone, themselves included.
	for _, c := range []*Client{watcher, player} {
		names, statuses := presenceFramesOf(t, c, player.userID)
		if len(names) != 1 || names[0] != "" || statuses[0] != db.StatusOnline {
			t.Fatalf("viewer %d saw %v / %v for the player, want one online presence with null", c.userID, names, statuses)
		}
	}
	// The invisible user's clear is on their own frame only.
	if names, _ := presenceFramesOf(t, watcher, ghost.userID); len(names) != 0 {
		t.Fatalf("the invisible user's clear reached another member: %v", names)
	}
	names, statuses := presenceFramesOf(t, ghost, ghost.userID)
	if len(names) != 1 || names[0] != "" || statuses[0] != db.StatusInvisible {
		t.Fatalf("invisible self saw %v / %v, want one invisible presence with null", names, statuses)
	}
}

func TestGameActivityPolicy_OffRefusesSetWithoutBudget(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	player := connect("gaprefuse", true)
	watcher := connect("gaprefusewatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	saveGameActivitySwitch(t, h, database, false)
	drain(player.send)
	drain(watcher.send)

	for range 3 {
		sendActivity(t, h, player, "Factorio")
		own := drain(player.send)
		if len(own) != 1 || activityErrCode(t, own[0]) != ErrCodeGameActivityDisabled {
			t.Fatalf("set while off answered %q, want GAME_ACTIVITY_DISABLED", own)
		}
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("a refused set broadcast %q", frames)
	}
	if player.livePresence().activity != nil {
		t.Fatal("a refused set stored an activity")
	}

	// The refusals took no budget: the first set after switching back on is
	// accepted, not RATE_LIMITED.
	saveGameActivitySwitch(t, h, database, true)
	drain(player.send)
	sendActivity(t, h, player, "Factorio")
	for _, raw := range drain(player.send) {
		if code := activityErrCode(t, raw); code != "("+MsgTypePresence+")" {
			t.Fatalf("set after switching on answered %s, want it accepted", code)
		}
	}
	if a := player.livePresence().activity; a == nil || a.Name != "Factorio" {
		t.Fatalf("activity after switching on = %+v, want Factorio", a)
	}
}

func TestGameActivityPolicy_OffClearIsNoop(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	player := connect("gapnoop", true)
	watcher := connect("gapnoopwatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	saveGameActivitySwitch(t, h, database, false)
	drain(player.send)
	drain(watcher.send)

	sendActivity(t, h, player, "")
	if frames := drain(player.send); len(frames) != 0 {
		t.Fatalf("a clear with nothing stored answered %q", frames)
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("a clear with nothing stored broadcast %q", frames)
	}
}

// The handler check only decides the reply; the flag read under presenceMu
// is what keeps a set that raced the sweep from surviving it.
func TestGameActivityPolicy_ApplyAfterSwitchDropsSet(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	player := connect("gapdrop", true)
	watcher := connect("gapdropwatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	drain(watcher.send)

	h.gameActivity.on.Store(false)
	h.applyActivity(player, &gameActivity{Name: "Factorio", StartedAt: time.Now().UnixMilli()})
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if player.livePresence().activity != nil {
		t.Fatal("applyActivity stored a set after the switch went off")
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("a dropped set broadcast %q", frames)
	}

	// A clear is always applied.
	h.gameActivity.on.Store(true)
	h.applyActivity(player, &gameActivity{Name: "Factorio", StartedAt: time.Now().UnixMilli()})
	h.gameActivity.on.Store(false)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	drain(watcher.send)
	h.applyActivity(player, nil)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if player.livePresence().activity != nil {
		t.Fatal("a clear was not applied while off")
	}
	if names, _ := presenceFramesOf(t, watcher, player.userID); len(names) != 1 || names[0] != "" {
		t.Fatalf("clear while off broadcast %v, want one null", names)
	}
}

// C1: presence_update builds its events from the activity it snapshotted at
// dispatch and emits them later. A sweep in between must not be undone by
// that older game, on the public frame or on the owner's own.
func TestGameActivityPolicy_PresenceUpdateAfterSweepCarriesNoActivity(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	player := connect("gapstale", true)
	ghost := connect("gapstaleghost", true)
	watcher := connect("gapstalewatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	sendActivity(t, h, player, "Factorio")
	sendActivity(t, h, ghost, "Secret Game")
	stale := player.livePresence().activity
	staleGhost := ghost.livePresence().activity
	if stale == nil || staleGhost == nil {
		t.Fatal("setup: no activity stored")
	}

	// The events a presence_update would have built before the sweep.
	pubEvents := presenceEvents(player.userID, db.StatusDND, nil, stale, nil)
	ghostEvents := presenceEvents(ghost.userID, db.StatusInvisible, nil, staleGhost, nil)

	saveGameActivitySwitch(t, h, database, false)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	drain(player.send)
	drain(ghost.send)
	drain(watcher.send)

	h.EmitEvents(context.Background(), append(pubEvents, ghostEvents...))
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}

	names, statuses := presenceFramesOf(t, watcher, player.userID)
	if len(names) != 1 || names[0] != "" || statuses[0] != db.StatusDND {
		t.Fatalf("watcher saw %v / %v for the status change, want dnd with null activity", names, statuses)
	}
	names, statuses = presenceFramesOf(t, ghost, ghost.userID)
	if len(names) != 1 || names[0] != "" || statuses[0] != db.StatusInvisible {
		t.Fatalf("invisible self saw %v / %v, want invisible with null activity", names, statuses)
	}
}

func readyPolicyView(t *testing.T, h *Hub, database *db.DB, userID int64) (caps map[string]any, activities []readyActivityPayload) {
	t.Helper()
	raw, err := h.readyBytes(database, userID, nil)
	if err != nil {
		t.Fatalf("readyBytes: %v", err)
	}
	var env struct {
		Payload struct {
			Activities   []readyActivityPayload `json:"activities"`
			Capabilities map[string]any         `json:"capabilities"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if env.Payload.Activities == nil {
		t.Fatal("ready has no activities array")
	}
	return env.Payload.Capabilities, env.Payload.Activities
}

func TestGameActivityPolicy_ReadyAdvertisesFalseAndEmptyActivities(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	viewer := connect("gapready", true)
	gamer := connect("gapreadygamer", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	sendActivity(t, h, gamer, "Factorio")
	if caps, acts := readyPolicyView(t, h, database, viewer.userID); caps["game_activity"] != true || len(acts) != 1 {
		t.Fatalf("while on: capability %v, activities %+v, want true and the game", caps["game_activity"], acts)
	}

	saveGameActivitySwitch(t, h, database, false)
	caps, acts := readyPolicyView(t, h, database, viewer.userID)
	if caps["game_activity"] != false {
		t.Errorf("capabilities.game_activity = %v, want false while off", caps["game_activity"])
	}
	if len(acts) != 0 {
		t.Errorf("ready.activities = %+v, want empty while off", acts)
	}

	saveGameActivitySwitch(t, h, database, true)
	if caps, _ := readyPolicyView(t, h, database, viewer.userID); caps["game_activity"] != true {
		t.Errorf("capabilities.game_activity = %v, want true again", caps["game_activity"])
	}
}

func authOKPolicy(t *testing.T, h *Hub, database *db.DB, name, replaySource string) bool {
	t.Helper()
	id, err := database.CreateUser(context.Background(), name, "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	u, err := database.GetUserByID(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		Payload struct {
			Policy *struct {
				Enabled bool `json:"enabled"`
			} `json:"game_activity_policy"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(h.buildAuthOK(context.Background(), u, "member", nil, replaySource), &env); err != nil {
		t.Fatal(err)
	}
	if env.Payload.Policy == nil {
		t.Fatalf("auth_ok (%s) has no game_activity_policy", replaySource)
	}
	return env.Payload.Policy.Enabled
}

// A resume gets no ready, so auth_ok must carry the policy on its own: the
// fresh-connect and the resume tiers ("buffer", "db") build it the same way.
func TestGameActivityPolicy_AuthOkCarriesPolicy_ConnectAndResume(t *testing.T) {
	h, database, _ := presenceBatchHub(t)
	for _, source := range []string{"none", "buffer", "db"} {
		if !authOKPolicy(t, h, database, "gapauthon"+source, source) {
			t.Errorf("auth_ok (%s) policy = false while on", source)
		}
	}
	saveGameActivitySwitch(t, h, database, false)
	for _, source := range []string{"none", "buffer", "db"} {
		if authOKPolicy(t, h, database, "gapauthoff"+source, source) {
			t.Errorf("auth_ok (%s) policy = true while off", source)
		}
	}
}

func TestGameActivityPolicy_FrameUnsequencedToAll(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	a := connect("gapframea", true)
	b := connect("gapframeb", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	drain(a.send)
	drain(b.send)
	before := atomic.LoadUint64(&h.seq)

	saveGameActivitySwitch(t, h, database, false)
	for _, c := range []*Client{a, b} {
		if got := policyFrames(t, c); len(got) != 1 || got[0] {
			t.Fatalf("client %d policy frames = %v, want one false", c.userID, got)
		}
	}
	// Nothing was stored, so no presence frame took a seq either: the policy
	// frame is the only thing sent, and it sits outside the replay ring.
	if after := atomic.LoadUint64(&h.seq); after != before {
		t.Fatalf("seq moved %d -> %d: the policy frame was sequenced", before, after)
	}

	saveGameActivitySwitch(t, h, database, true)
	for _, c := range []*Client{a, b} {
		if got := policyFrames(t, c); len(got) != 1 || !got[0] {
			t.Fatalf("client %d policy frames = %v, want one true", c.userID, got)
		}
	}
}

func TestGameActivityPolicy_OnAgainAcceptsSet(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	player := connect("gapagain", true)
	watcher := connect("gapagainwatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	sendActivity(t, h, player, "Factorio")
	saveGameActivitySwitch(t, h, database, false)
	saveGameActivitySwitch(t, h, database, true)
	if !h.gameActivity.on.Load() {
		t.Fatal("flag still off after switching on")
	}
	drain(player.send)
	drain(watcher.send)

	h.limiter.Reset(context.Background(), auth.Key("activity", player.userID))
	sendActivity(t, h, player, "Satisfactory")
	if names, _ := presenceFramesOf(t, watcher, player.userID); len(names) != 1 || names[0] != "Satisfactory" {
		t.Fatalf("watcher saw %v after switching on, want Satisfactory", names)
	}
}

// settingsStub answers the game activity key itself and everything else from
// the real settings service.
type settingsStub struct {
	real  SettingsReader
	value string
	err   error
}

func (s settingsStub) Setting(ctx context.Context, key string) (string, error) {
	if key == service.GameActivityEnabledKey {
		return s.value, s.err
	}
	return s.real.Setting(ctx, key)
}

// captureWarns routes slog to a buffer for the test and returns it.
func captureWarns(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

func TestGameActivityPolicy_InitReadsStoredFalse(t *testing.T) {
	database := newTeardownTestDB(t)
	if err := database.SetSetting(context.Background(), service.GameActivityEnabledKey, "false"); err != nil {
		t.Fatal(err)
	}
	h := newTestHubWith(t, HubOptions{DB: database})
	if h.gameActivity.on.Load() {
		t.Fatal("a stored false did not start the hub off")
	}

	// No row means on.
	h2 := newTestHub(t, newTeardownTestDB(t), nil, nil)
	if !h2.gameActivity.on.Load() {
		t.Fatal("a missing row did not start the hub on")
	}
}

func TestGameActivityPolicy_InitReadErrorFailsClosed(t *testing.T) {
	database := newTeardownTestDB(t)
	buf := captureWarns(t)
	h := newTestHubWith(t, HubOptions{
		DB:       database,
		Settings: settingsStub{real: service.NewSettingsService(database), err: errors.New("settings read failed")},
	})
	if h.gameActivity.on.Load() {
		t.Fatal("an unreadable setting started the hub on, want fail closed")
	}
	out := buf.String()
	if !bytes.Contains([]byte(out), []byte("game_activity_policy: reading the setting failed")) || !bytes.Contains([]byte(out), []byte("stage=init")) {
		t.Fatalf("warn log = %q, want the init warning", out)
	}
}

// A failed re-read on a save falls back to the value the admin just saved.
func TestGameActivityPolicy_ApplyReadErrorUsesSavedValue(t *testing.T) {
	database := newTeardownTestDB(t)
	stub := &switchableSettings{real: service.NewSettingsService(database)}
	h := newTestHubWith(t, HubOptions{DB: database, Settings: stub})
	buf := captureWarns(t)
	stub.err = errors.New("settings read failed")

	h.ApplyGameActivityPolicy(false)
	if h.gameActivity.on.Load() {
		t.Fatal("the saved false was not used after a failed re-read")
	}
	if !bytes.Contains(buf.Bytes(), []byte("stage=apply")) {
		t.Fatalf("warn log = %q, want the apply warning", buf.String())
	}
	h.ApplyGameActivityPolicy(true)
	if !h.gameActivity.on.Load() {
		t.Fatal("the saved true was not used after a failed re-read")
	}
}

type switchableSettings struct {
	real SettingsReader
	err  error
}

func (s *switchableSettings) Setting(ctx context.Context, key string) (string, error) {
	if key == service.GameActivityEnabledKey && s.err != nil {
		return "", s.err
	}
	return s.real.Setting(ctx, key)
}

// Sets racing the switch-off: whichever order they land in, nothing is left
// shown and the last presence frame each member sent carries a null game.
// Run under -race.
func TestGameActivityPolicy_ConcurrentSetsAndSwitchOff_NoneSurvive(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	const players = 8
	clients := make([]*Client, players)
	for i := range clients {
		clients[i] = connect(fmt.Sprintf("gapconc%d", i), true)
	}
	observer := connect("gapconcobs", true)
	settle(t, h)
	drain(observer.send)
	if err := database.SetSetting(context.Background(), service.GameActivityEnabledKey, "false"); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, c := range clients {
		wg.Go(func() {
			<-start
			h.applyActivity(c, &gameActivity{Name: "Factorio", StartedAt: time.Now().UnixMilli()})
		})
	}
	wg.Go(func() {
		<-start
		h.ApplyGameActivityPolicy(false)
	})
	close(start)
	wg.Wait()
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}

	for _, c := range clients {
		if a := c.livePresence().activity; a != nil {
			t.Errorf("user %d still shows %+v after the switch-off", c.userID, a)
		}
	}
	last := map[int64]string{}
	for _, raw := range drain(observer.send) {
		var f actFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		if f.Type != MsgTypePresence {
			continue
		}
		name, _ := activityName(t, f.Payload.Activity)
		last[f.Payload.UserID] = name
	}
	for uid, name := range last {
		if name != "" {
			t.Errorf("the last presence frame for user %d carries %q, want null", uid, name)
		}
	}
}

// Off then on again before a stale presence_update emits: the flag is true,
// but the sweep already cleared the live game, so the old snapshot must not
// bring it back, on the public frame or on the owner's own.
func TestGameActivityPolicy_StalePresenceAfterOffThenOnCarriesNoActivity(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	player := connect("gapoffon", true)
	ghost := connect("gapoffonghost", true)
	watcher := connect("gapoffonwatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	sendActivity(t, h, player, "Factorio")
	sendActivity(t, h, ghost, "Secret Game")
	pubEvents := presenceEvents(player.userID, db.StatusDND, nil, player.livePresence().activity, nil)
	ghostEvents := presenceEvents(ghost.userID, db.StatusInvisible, nil, ghost.livePresence().activity, nil)

	saveGameActivitySwitch(t, h, database, false)
	saveGameActivitySwitch(t, h, database, true)
	drain(player.send)
	drain(ghost.send)
	drain(watcher.send)

	h.EmitEvents(context.Background(), append(pubEvents, ghostEvents...))
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if names, _ := presenceFramesOf(t, watcher, player.userID); len(names) != 1 || names[0] != "" {
		t.Fatalf("watcher saw %v, want one frame with null activity", names)
	}
	if names, _ := presenceFramesOf(t, ghost, ghost.userID); len(names) != 1 || names[0] != "" {
		t.Fatalf("invisible self saw %v, want one frame with null activity", names)
	}
}
