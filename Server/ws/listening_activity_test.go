package ws

// listening_activity_test.go — WP 8.10a: the listening_update frame and the
// song carried on presence, presence_batch and ready.listening, plus the
// per-server switch (game_activity_enabled) that covers it. The song is memory
// only and lives on the connection's livePresence next to the game.

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

func TestListeningUpdate_Parse(t *testing.T) {
	ctor, ok := getCommandConstructor(MsgTypeListeningUpdate)
	if !ok {
		t.Fatal("no listening_update constructor")
	}
	a128 := strings.Repeat("a", 128)
	a129 := strings.Repeat("a", 129)
	p64 := strings.Repeat("p", 64)
	p65 := strings.Repeat("p", 65)
	day := (24 * time.Hour).Milliseconds()
	body := func(title, artist, player, startedAt, duration string) string {
		return `{"listening":{"title":` + title + `,"artist":` + artist + `,"player":` + player +
			`,"started_at":` + startedAt + `,"duration_ms":` + duration + `}}`
	}
	ok1 := func(title, artist, player string) string {
		return body(strconv.Quote(title), strconv.Quote(artist), strconv.Quote(player), "5", "1000")
	}
	cases := []struct {
		name    string
		payload string
		wantErr bool
		want    ListeningUpdateCmd
	}{
		{"set", body(`"Song"`, `"Band"`, `"Spotify"`, "1700000000000", "215000"), false,
			ListeningUpdateCmd{Title: "Song", Artist: "Band", Player: "Spotify", StartedAt: 1700000000000, DurationMS: 215000}},
		{"texts are trimmed and collapsed", ok1("  Big   Song \t", " The  Band ", " Spo tify "), false,
			ListeningUpdateCmd{Title: "Big Song", Artist: "The Band", Player: "Spo tify", StartedAt: 5, DurationMS: 1000}},
		{"empty artist is allowed", ok1("Song", "", "Spotify"), false,
			ListeningUpdateCmd{Title: "Song", Artist: "", Player: "Spotify", StartedAt: 5, DurationMS: 1000}},
		{"blank artist is empty", ok1("Song", "   ", "Spotify"), false,
			ListeningUpdateCmd{Title: "Song", Artist: "", Player: "Spotify", StartedAt: 5, DurationMS: 1000}},
		{"128 chars title and artist, 64 player", ok1(a128, a128, p64), false,
			ListeningUpdateCmd{Title: a128, Artist: a128, Player: p64, StartedAt: 5, DurationMS: 1000}},
		{"129 chars title", ok1(a129, "x", "p"), true, ListeningUpdateCmd{}},
		{"129 chars artist", ok1("x", a129, "p"), true, ListeningUpdateCmd{}},
		{"65 chars player", ok1("x", "x", p65), true, ListeningUpdateCmd{}},
		{"empty player", ok1("x", "x", ""), true, ListeningUpdateCmd{}},
		{"blank player", ok1("x", "x", "   "), true, ListeningUpdateCmd{}},
		{"line break in title", ok1("a\nb", "x", "p"), true, ListeningUpdateCmd{}},
		{"control char in artist", ok1("x", "a\u0007b", "p"), true, ListeningUpdateCmd{}},
		{"bidi override in player", ok1("x", "x", "a\u202eb"), true, ListeningUpdateCmd{}},
		{"invisible filler in title", ok1("aㅤb", "x", "p"), true, ListeningUpdateCmd{}},
		{"empty title clears", ok1("", "x", "p"), false, ListeningUpdateCmd{Clear: true}},
		{"blank title clears", ok1("   ", "x", "p"), false, ListeningUpdateCmd{Clear: true}},
		{"null clears", `{"listening":null}`, false, ListeningUpdateCmd{Clear: true}},
		{"duration 0 means unknown", body(`"S"`, `"A"`, `"P"`, "5", "0"), false,
			ListeningUpdateCmd{Title: "S", Artist: "A", Player: "P", StartedAt: 5, DurationMS: 0}},
		{"duration capped at 24h", body(`"S"`, `"A"`, `"P"`, "5", strconv.FormatInt(day*3, 10)), false,
			ListeningUpdateCmd{Title: "S", Artist: "A", Player: "P", StartedAt: 5, DurationMS: day}},
		{"negative duration", body(`"S"`, `"A"`, `"P"`, "5", "-1"), true, ListeningUpdateCmd{}},
		{"duration is a string", body(`"S"`, `"A"`, `"P"`, "5", `"9"`), true, ListeningUpdateCmd{}},
		{"duration is a fraction", body(`"S"`, `"A"`, `"P"`, "5", "9.5"), true, ListeningUpdateCmd{}},
		{"duration is null", body(`"S"`, `"A"`, `"P"`, "5", "null"), true, ListeningUpdateCmd{}},
		{"started_at is a string", body(`"S"`, `"A"`, `"P"`, `"5"`, "1"), true, ListeningUpdateCmd{}},
		{"started_at is a fraction", body(`"S"`, `"A"`, `"P"`, "5.5", "1"), true, ListeningUpdateCmd{}},
		{"title is a number", body(`7`, `"A"`, `"P"`, "5", "1"), true, ListeningUpdateCmd{}},
		{"artist is a number", body(`"S"`, `7`, `"P"`, "5", "1"), true, ListeningUpdateCmd{}},
		{"player is null", body(`"S"`, `"A"`, `null`, "5", "1"), true, ListeningUpdateCmd{}},
		{"title missing", `{"listening":{"artist":"A","player":"P","started_at":5,"duration_ms":1}}`, true, ListeningUpdateCmd{}},
		{"artist missing", `{"listening":{"title":"S","player":"P","started_at":5,"duration_ms":1}}`, true, ListeningUpdateCmd{}},
		{"player missing", `{"listening":{"title":"S","artist":"A","started_at":5,"duration_ms":1}}`, true, ListeningUpdateCmd{}},
		{"started_at missing", `{"listening":{"title":"S","artist":"A","player":"P","duration_ms":1}}`, true, ListeningUpdateCmd{}},
		{"duration_ms missing", `{"listening":{"title":"S","artist":"A","player":"P","started_at":5}}`, true, ListeningUpdateCmd{}},
		{"missing listening", `{}`, true, ListeningUpdateCmd{}},
		{"listening is a string", `{"listening":"Song"}`, true, ListeningUpdateCmd{}},
		{"listening is an array", `{"listening":[]}`, true, ListeningUpdateCmd{}},
		{"payload not an object", `[]`, true, ListeningUpdateCmd{}},
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
		got := cmd.(ListeningUpdateCmd)
		want := tc.want
		want.userID = 1
		if got != want {
			t.Errorf("%s: cmd = %+v, want %+v", tc.name, got, want)
		}
	}
}

// A bad payload reaches the client as BAD_REQUEST, through the real frame path.
func TestListeningUpdate_BadPayloadAnswersBadRequest(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	c := connect("lisbadpayload", true)
	for _, payload := range []string{
		`{"listening":{"title":"` + strings.Repeat("a", 129) + `","artist":"A","player":"P","started_at":5,"duration_ms":1}}`,
		`{"listening":{"title":"S","artist":"A","player":"","started_at":5,"duration_ms":1}}`,
		`{"listening":{"title":"S","artist":"A","player":"P","started_at":"5","duration_ms":1}}`,
		`{"listening":{"title":"S","artist":"A","player":"P","started_at":5,"duration_ms":-1}}`,
		`{"listening":{"title":"S","artist":"A","player":"P","started_at":5}}`,
		`{"listening":7}`,
	} {
		h.handleMessage(c, []byte(`{"type":"listening_update","id":"r1","payload":`+payload+`}`))
		frames := drain(c.send)
		if len(frames) != 1 || activityErrCode(t, frames[0]) != ErrCodeBadRequest {
			t.Fatalf("payload %s: frames = %q, want one BAD_REQUEST", payload, frames)
		}
	}
	if c.livePresence().listening != nil {
		t.Fatal("a rejected frame changed the live listening")
	}
}

func TestListeningUpdate_StartedAtClampedLikeGames(t *testing.T) {
	info := ClientInfo{UserID: 1}
	run := func(startedAt int64) *listeningActivity {
		t.Helper()
		// A fresh limiter per call: only the clamp is under test.
		deps := PresenceDeps{Limiter: auth.NewRateLimiter()}
		res := handleListeningUpdateV2(context.Background(),
			ListeningUpdateCmd{userID: 1, Title: "S", Artist: "A", Player: "P", StartedAt: startedAt, DurationMS: 4200}, info, deps)
		if res.Error != nil || res.SetListening == nil || res.SetListening.next == nil {
			t.Fatalf("result = %+v, want a listening value", res)
		}
		return res.SetListening.next
	}
	before := time.Now().UnixMilli()
	day := (24 * time.Hour).Milliseconds()

	if got := run(1).StartedAt; got < before-day || got > time.Now().UnixMilli()-day+1000 {
		t.Errorf("ancient started_at clamped to %d, want about now-24h", got)
	}
	if got := run(before + 10*day).StartedAt; got < before || got > time.Now().UnixMilli() {
		t.Errorf("future started_at clamped to %d, want about now", got)
	}
	inRange := before - 3600_000
	got := run(inRange)
	if got.StartedAt != inRange || got.DurationMS != 4200 || got.Title != "S" || got.Artist != "A" || got.Player != "P" {
		t.Errorf("in-range value = %+v, want it unchanged", got)
	}
}

// ---------------------------------------------------------------------------
// Rate limit, clear and no-op rules (handler level)
// ---------------------------------------------------------------------------

func TestListeningUpdate_RateLimitAndClearRules(t *testing.T) {
	ctx := context.Background()
	deps := PresenceDeps{Limiter: auth.NewRateLimiter()}
	now := time.Now().UnixMilli()
	set := func(title string, cur *listeningActivity) Result {
		return handleListeningUpdateV2(ctx, ListeningUpdateCmd{userID: 1, Title: title, Artist: "A", Player: "P", StartedAt: now}, ClientInfo{UserID: 1, Listening: cur}, deps)
	}
	clear := func(cur *listeningActivity) Result {
		return handleListeningUpdateV2(ctx, ListeningUpdateCmd{userID: 1, Clear: true}, ClientInfo{UserID: 1, Listening: cur}, deps)
	}

	first := set("One", nil)
	if first.Error != nil || first.SetListening == nil || first.SetListening.next == nil {
		t.Fatalf("first set = %+v, want it applied", first)
	}
	cur := first.SetListening.next

	second := set("Two", cur)
	ce, ok := errors.AsType[ClientError](second.Error)
	if !ok || ce.Code != ErrCodeRateLimited || second.SetListening != nil {
		t.Fatalf("second set = %+v, want RATE_LIMITED and no change", second)
	}

	for i := range 3 {
		res := clear(cur)
		if res.Error != nil || res.SetListening == nil || res.SetListening.next != nil {
			t.Fatalf("clear #%d = %+v, want a clear that was not limited", i, res)
		}
	}
	if res := clear(nil); res.Error != nil || res.SetListening != nil || len(res.Events) != 0 {
		t.Fatalf("clear with nothing set = %+v, want an empty result", res)
	}
}

// The listening budget is its own: a game start does not spend it and a song
// does not spend the game's.
func TestListeningUpdate_BudgetIsSeparateFromGames(t *testing.T) {
	ctx := context.Background()
	deps := PresenceDeps{Limiter: auth.NewRateLimiter()}
	now := time.Now().UnixMilli()
	g := handleActivityUpdateV2(ctx, ActivityUpdateCmd{userID: 1, Name: "Factorio", StartedAt: now}, ClientInfo{UserID: 1}, deps)
	if g.Error != nil || g.SetActivity == nil {
		t.Fatalf("game set = %+v", g)
	}
	l := handleListeningUpdateV2(ctx, ListeningUpdateCmd{userID: 1, Title: "S", Artist: "A", Player: "P", StartedAt: now}, ClientInfo{UserID: 1}, deps)
	if l.Error != nil || l.SetListening == nil {
		t.Fatalf("song set after a game set = %+v, want it accepted", l)
	}
	g2 := handleActivityUpdateV2(ctx, ActivityUpdateCmd{userID: 1, Name: "Celeste", StartedAt: now}, ClientInfo{UserID: 1, Activity: g.SetActivity.next}, deps)
	if ce, ok := errors.AsType[ClientError](g2.Error); !ok || ce.Code != ErrCodeRateLimited {
		t.Fatalf("second game set = %+v, want RATE_LIMITED (own budget)", g2)
	}
}

func TestListeningUpdate_SameSongIsNoOpAndSpendsNoBudget(t *testing.T) {
	ctx := context.Background()
	deps := PresenceDeps{Limiter: auth.NewRateLimiter()}
	at := time.Now().UnixMilli() - 5000
	cur := &listeningActivity{Title: "Song", Artist: "Band", Player: "Spotify", StartedAt: at, DurationMS: 200000}
	cmd := func(title, artist, player string, startedAt, dur int64) ListeningUpdateCmd {
		return ListeningUpdateCmd{userID: 1, Title: title, Artist: artist, Player: player, StartedAt: startedAt, DurationMS: dur}
	}
	run := func(c ListeningUpdateCmd, cur *listeningActivity) Result {
		return handleListeningUpdateV2(ctx, c, ClientInfo{UserID: 1, Listening: cur}, deps)
	}

	for name, c := range map[string]ListeningUpdateCmd{
		"identical":                  cmd("Song", "Band", "Spotify", at, 200000),
		"a seek moved started_at":    cmd("Song", "Band", "Spotify", at-60_000, 200000),
		"duration now known/changed": cmd("Song", "Band", "Spotify", at, 0),
	} {
		if res := run(c, cur); res.Error != nil || res.SetListening != nil || len(res.Events) != 0 {
			t.Errorf("%s = %+v, want an empty result", name, res)
		}
	}
	// A different title, artist or player is a change.
	for name, c := range map[string]ListeningUpdateCmd{
		"title":  cmd("Other", "Band", "Spotify", at, 200000),
		"artist": cmd("Song", "Other", "Spotify", at, 200000),
		"player": cmd("Song", "Band", "Other", at, 200000),
	} {
		deps.Limiter = auth.NewRateLimiter()
		if res := run(c, cur); res.Error != nil || res.SetListening == nil || res.SetListening.next == nil {
			t.Errorf("different %s = %+v, want it applied", name, res)
		}
	}
	// The no-ops took no budget, so a real change right after is allowed.
	deps.Limiter = auth.NewRateLimiter()
	run(cmd("Song", "Band", "Spotify", at, 200000), cur)
	if res := run(cmd("Next", "Band", "Spotify", at, 200000), cur); res.Error != nil || res.SetListening == nil {
		t.Fatalf("change after a no-op = %+v, want it applied", res)
	}
}

// ---------------------------------------------------------------------------
// Broadcast behaviour through the hub
// ---------------------------------------------------------------------------

type lisFrame struct {
	Type    string `json:"type"`
	Payload struct {
		UserID    int64           `json:"user_id"`
		Status    string          `json:"status"`
		Activity  json.RawMessage `json:"activity"`
		Listening json.RawMessage `json:"listening"`
		Updates   []struct {
			UserID    int64           `json:"user_id"`
			Status    string          `json:"status"`
			Activity  json.RawMessage `json:"activity"`
			Listening json.RawMessage `json:"listening"`
		} `json:"updates"`
		Full bool `json:"full"`
	} `json:"payload"`
}

// decodeListening decodes a "listening" value into its title ("" for null)
// and fails the test when the key was missing.
func decodeListening(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	if raw == nil {
		t.Fatal("frame has no listening key")
	}
	if string(raw) == "null" {
		return ""
	}
	var l struct {
		Title      string  `json:"title"`
		Artist     *string `json:"artist"`
		Player     string  `json:"player"`
		StartedAt  int64   `json:"started_at"`
		DurationMS *int64  `json:"duration_ms"`
	}
	if err := json.Unmarshal(raw, &l); err != nil {
		t.Fatalf("listening %s: %v", raw, err)
	}
	if l.Artist == nil || l.Player == "" || l.StartedAt <= 0 || l.DurationMS == nil {
		t.Fatalf("listening %s is missing a field", raw)
	}
	return l.Title
}

type presSeen struct{ status, game, song string }

// presFramesOf returns the presence frames about userID among c's queued
// frames, in order, with the game name and song title each carries ("" for
// null). It fails the test if a frame omits either key.
func presFramesOf(t *testing.T, c *Client, userID int64) []presSeen {
	t.Helper()
	return presFramesIn(t, drain(c.send), userID)
}

// presFramesIn is presFramesOf over frames already drained, for a test that
// reads several users' frames off one queue.
func presFramesIn(t *testing.T, frames [][]byte, userID int64) []presSeen {
	t.Helper()
	var out []presSeen
	for _, raw := range frames {
		var f lisFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("frame %s: %v", raw, err)
		}
		if f.Type != MsgTypePresence || f.Payload.UserID != userID {
			continue
		}
		game, absent := activityName(t, f.Payload.Activity)
		if absent {
			t.Fatalf("presence frame %s has no activity key", raw)
		}
		out = append(out, presSeen{f.Payload.Status, game, decodeListening(t, f.Payload.Listening)})
	}
	return out
}

func sendListening(t *testing.T, h *Hub, c *Client, title string) {
	t.Helper()
	body := `{"type":"listening_update","payload":{"listening":null}}`
	if title != "" {
		body = `{"type":"listening_update","payload":{"listening":{"title":"` + title + `","artist":"Band","player":"Spotify","started_at":` +
			activityItoa(time.Now().UnixMilli()-1000) + `,"duration_ms":215000}}}`
	}
	h.handleMessage(c, []byte(body))
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestListeningUpdate_BroadcastsPresenceWithTheLiveStatus(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	player := connect("lisplayer", true)
	watcher := connect("liswatcher", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	text := "afk soon"
	player.setLivePresence(db.StatusDND, &text, "")
	drain(player.send)
	drain(watcher.send)

	sendListening(t, h, player, "Song")

	got := presFramesOf(t, watcher, player.userID)
	if len(got) != 1 || got[0] != (presSeen{db.StatusDND, "", "Song"}) {
		t.Fatalf("watcher saw %+v, want one dnd presence carrying Song", got)
	}
	if lp := player.livePresence(); lp.listening == nil || lp.listening.Title != "Song" || lp.status != db.StatusDND || lp.customStatus == nil || *lp.customStatus != text {
		t.Fatalf("live presence = %+v, want the song set and status/text kept", lp)
	}
}

func TestListeningUpdate_ClearAndNoOpBroadcastRules(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	player := connect("lisclearer", true)
	watcher := connect("lisclearwatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	drain(player.send)
	drain(watcher.send)

	// A clear with nothing set broadcasts nothing and answers nothing.
	sendListening(t, h, player, "")
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("clear with nothing set broadcast %q", frames)
	}
	if frames := drain(player.send); len(frames) != 0 {
		t.Fatalf("clear with nothing set answered %q", frames)
	}

	sendListening(t, h, player, "Song")
	if got := presFramesOf(t, watcher, player.userID); len(got) != 1 {
		t.Fatalf("set broadcast %+v, want one frame", got)
	}
	drain(player.send)

	// The same song again, with a seek (another started_at): no frame, no
	// error, and the shown started_at is kept.
	cur := player.livePresence().listening
	same := []byte(`{"type":"listening_update","payload":{"listening":{"title":"Song","artist":"Band","player":"Spotify","started_at":` +
		activityItoa(cur.StartedAt-30_000) + `,"duration_ms":215000}}}`)
	h.handleMessage(player, same)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("same song broadcast %q", frames)
	}
	if frames := drain(player.send); len(frames) != 0 {
		t.Fatalf("same song answered %q", frames)
	}
	if now := player.livePresence().listening; now == nil || now.StartedAt != cur.StartedAt {
		t.Fatalf("listening after a seek = %+v, want started_at %d kept", now, cur.StartedAt)
	}

	// A different song inside the window is RATE_LIMITED and changes nothing.
	sendListening(t, h, player, "Other")
	own := drain(player.send)
	if len(own) != 1 || activityErrCode(t, own[0]) != ErrCodeRateLimited {
		t.Fatalf("second set answered %q, want RATE_LIMITED", own)
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("a refused set broadcast %q", frames)
	}
	if l := player.livePresence().listening; l == nil || l.Title != "Song" {
		t.Fatalf("listening after a refused set = %+v, want Song", l)
	}

	// A clear is never limited and does broadcast the null.
	sendListening(t, h, player, "")
	if got := presFramesOf(t, watcher, player.userID); len(got) != 1 || got[0].song != "" {
		t.Fatalf("clear broadcast %+v, want one null listening", got)
	}
	if player.livePresence().listening != nil {
		t.Fatal("clear left the song set")
	}
}

// Edge case (a): a replacement connection starts empty; the replaced
// connection's late listening_update and its disconnect do not touch it.
func TestListeningUpdate_ReplacedConnectionCannotTouchTheNewOne(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	ctx := context.Background()
	old := connect("lisreplaced", true)
	watcher := connect("lisreplwatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	sendListening(t, h, old, "Song")
	drain(old.send)
	drain(watcher.send)

	u, err := database.GetUserByID(ctx, old.userID)
	if err != nil {
		t.Fatal(err)
	}
	fresh := herdClient(ctx, h, u)
	h.registerNowTest(fresh, nil)
	fresh.user.Status = db.StatusOnline
	fresh.setLivePresence(db.StatusOnline, nil, "")
	if fresh.livePresence().listening != nil {
		t.Fatal("a replacement connection did not start empty")
	}
	drain(watcher.send)

	// The replaced connection's late set changes nothing and says nothing.
	h.limiter.Reset(ctx, auth.Key("listening", old.userID))
	sendListening(t, h, old, "Late Song")
	if l := fresh.livePresence().listening; l != nil {
		t.Fatalf("the replaced connection's late set reached the new one: %+v", l)
	}
	if got := presFramesOf(t, watcher, old.userID); len(got) != 0 {
		t.Fatalf("the replaced connection's late set broadcast %+v", got)
	}
	// A frame that raced the replacement past the handler, and a late clear.
	h.applyListening(old, &listeningActivity{Title: "Raced", Artist: "A", Player: "P", StartedAt: time.Now().UnixMilli()})
	h.applyListening(old, nil)
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	if l := fresh.livePresence().listening; l != nil {
		t.Fatalf("a racing apply from the replaced connection reached the new one: %+v", l)
	}
	if got := presFramesOf(t, watcher, old.userID); len(got) != 0 {
		t.Fatalf("a racing apply from the replaced connection broadcast %+v", got)
	}

	// The new connection sets its own; the replaced one then disconnects.
	h.limiter.Reset(ctx, auth.Key("listening", old.userID))
	sendListening(t, h, fresh, "New Song")
	drain(watcher.send)
	if replaced := h.unregisterNow(old); !replaced {
		t.Fatal("unregisterNow did not report a replacement")
	}
	if h.shouldMarkOffline(old, true) {
		t.Fatal("the replaced connection's disconnect would mark the user offline")
	}
	if l := fresh.livePresence().listening; l == nil || l.Title != "New Song" {
		t.Fatalf("the new connection's song after the old one left = %+v, want New Song", l)
	}
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	if got := presFramesOf(t, watcher, old.userID); len(got) != 0 {
		t.Fatalf("the replaced connection's disconnect broadcast %+v", got)
	}
}

// A real disconnect drops the song with the connection: the offline entry the
// others get carries null.
func TestListeningUpdate_DisconnectClearsIt(t *testing.T) {
	t.Parallel()
	h, _, connect := presenceBatchHub(t)
	player := connect("lisleaver", true)
	watcher := connect("lisleavewatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	sendListening(t, h, player, "Song")
	drain(watcher.send)

	if replaced := h.unregisterNow(player); replaced {
		t.Fatal("a plain disconnect was reported as a replacement")
	}
	h.QueuePresence(player.userID, db.StatusOffline, nil)
	settle(t, h)
	var sawOffline bool
	for _, raw := range drain(watcher.send) {
		var f lisFrame
		_ = json.Unmarshal(raw, &f)
		if f.Type != MsgTypePresenceBatch {
			continue
		}
		for _, e := range f.Payload.Updates {
			if e.UserID != player.userID {
				continue
			}
			sawOffline = true
			if decodeListening(t, e.Listening) != "" {
				t.Fatalf("offline entry listening = %s, want null", e.Listening)
			}
		}
	}
	if !sawOffline {
		t.Fatal("no offline entry for the disconnected player")
	}
}

// Edge case (b): a status change, a custom status expiry, an idle flip and a
// game set keep the song on every presence frame, and a song change keeps the
// game. Invisible blanks both for others but not for self.
func TestListening_SurvivesEveryOtherPresenceWriterAndKeepsTheGame(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	ctx := context.Background()
	player := connect("lisstatuser", true)
	watcher := connect("lisstatwatch", true)
	settle(t, h) // the connect-time presence flush must land before the test reads frames
	uid := player.userID
	sendListening(t, h, player, "Song")
	drain(player.send)
	drain(watcher.send)

	wantOne := func(c *Client, what string, want presSeen) {
		t.Helper()
		got := presFramesOf(t, c, uid)
		if len(got) != 1 || got[0] != want {
			t.Fatalf("%s: frames = %+v, want exactly %+v", what, got, want)
		}
	}
	setStatus := func(payload string) {
		t.Helper()
		h.limiter.Reset(ctx, auth.Key("presence", uid))
		//nolint:contextcheck // handleMessage is the read-pump entry and takes no context by design.
		h.handleMessage(player, []byte(`{"type":"presence_update","payload":`+payload+`}`))
		if err := h.awaitDispatch(ctx); err != nil {
			t.Fatal(err)
		}
	}

	// A game set keeps the song.
	sendActivity(t, h, player, "Factorio")
	wantOne(watcher, "game set watcher", presSeen{db.StatusOnline, "Factorio", "Song"})
	wantOne(player, "game set self", presSeen{db.StatusOnline, "Factorio", "Song"})

	// dnd with an expiring custom status.
	setStatus(`{"status":"dnd","custom_status":"deep work","custom_status_expires_in":60}`)
	wantOne(watcher, "dnd watcher", presSeen{db.StatusDND, "Factorio", "Song"})
	wantOne(player, "dnd self", presSeen{db.StatusDND, "Factorio", "Song"})

	// The custom status expires.
	tag := player.livePresence().customStatusExpiresAt
	if tag == "" {
		t.Fatal("no expiry tag on the live presence")
	}
	h.CustomStatusExpired(uid, tag)
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	wantOne(watcher, "expiry watcher", presSeen{db.StatusDND, "Factorio", "Song"})
	wantOne(player, "expiry self", presSeen{db.StatusDND, "Factorio", "Song"})
	if player.livePresence().listening == nil {
		t.Fatal("custom status expiry dropped the song")
	}

	// Idle.
	setStatus(`{"status":"idle"}`)
	wantOne(watcher, "idle watcher", presSeen{db.StatusIdle, "Factorio", "Song"})
	wantOne(player, "idle self", presSeen{db.StatusIdle, "Factorio", "Song"})

	// A song change keeps the game; a game clear keeps the song.
	h.limiter.Reset(ctx, auth.Key("listening", uid))
	sendListening(t, h, player, "Second")
	wantOne(watcher, "song change watcher", presSeen{db.StatusIdle, "Factorio", "Second"})
	drain(player.send)
	sendActivity(t, h, player, "")
	wantOne(watcher, "game clear watcher", presSeen{db.StatusIdle, "", "Second"})
	drain(player.send)

	// Invisible: others see offline and nothing; the player still sees the song.
	setStatus(`{"status":"invisible"}`)
	wantOne(watcher, "invisible watcher", presSeen{db.StatusOffline, "", ""})
	wantOne(player, "invisible self", presSeen{db.StatusInvisible, "", "Second"})

	// A new song while invisible reaches only the player.
	h.limiter.Reset(ctx, auth.Key("listening", uid))
	sendListening(t, h, player, "Third")
	if got := presFramesOf(t, watcher, uid); len(got) != 0 {
		t.Fatalf("invisible set watcher: frames = %+v, want none", got)
	}
	wantOne(player, "invisible set self", presSeen{db.StatusInvisible, "", "Third"})

	// Back online shows it again.
	setStatus(`{"status":"online"}`)
	wantOne(watcher, "online watcher", presSeen{db.StatusOnline, "", "Third"})
	wantOne(player, "online self", presSeen{db.StatusOnline, "", "Third"})
}

// ---------------------------------------------------------------------------
// presence_batch snapshot, ready.listening, capability
// ---------------------------------------------------------------------------

func snapshotListening(t *testing.T, c *Client) map[int64]string {
	t.Helper()
	var got map[int64]string
	for _, raw := range drain(c.send) {
		var f lisFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("frame %s: %v", raw, err)
		}
		if f.Type != MsgTypePresenceBatch || !f.Payload.Full {
			continue
		}
		got = map[int64]string{}
		for _, e := range f.Payload.Updates {
			got[e.UserID] = decodeListening(t, e.Listening)
		}
	}
	if got == nil {
		t.Fatalf("user %d got no full presence snapshot", c.userID)
	}
	return got
}

func TestListening_PresenceSnapshotCarriesItAndHidesInvisibleFromOthers(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	ctx := context.Background()
	observer := connect("lissnapobs", true)
	fan := connect("lissnapfan", true)
	ghost := connect("lissnapghost", true)
	quiet := connect("lissnapnone", true)
	sendListening(t, h, fan, "Song")
	sendListening(t, h, ghost, "Secret Song")
	ghost.setLivePresence(db.StatusInvisible, nil, "")
	settle(t, h)
	for _, c := range []*Client{observer, fan, ghost, quiet} {
		drain(c.send)
		c.presenceStale.Store(true)
	}
	h.enqueue(broadcastMsg{presenceSnapshot: true}, "presence snapshot")
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}

	seen := snapshotListening(t, observer)
	if seen[fan.userID] != "Song" {
		t.Errorf("observer sees fan listening %q, want Song", seen[fan.userID])
	}
	if title, listed := seen[quiet.userID]; !listed || title != "" {
		t.Errorf("observer sees quiet player as %q (listed=%v), want listed with null listening", title, listed)
	}
	if title, listed := seen[ghost.userID]; listed {
		t.Errorf("observer's snapshot lists the invisible user (listening %q)", title)
	}
	if own := snapshotListening(t, ghost)[ghost.userID]; own != "Secret Song" {
		t.Errorf("the invisible user's own snapshot listening = %q, want Secret Song", own)
	}
}

// The connect/disconnect coalescer's invisible variant: others get null, the
// subject's own copy carries the truth.
func TestListening_BatchEntryBlanksInvisibleForOthers(t *testing.T) {
	h, _, _ := presenceBatchHub(t)
	song := &listeningActivity{Title: "Secret", Artist: "A", Player: "P", StartedAt: 1, DurationMS: 2}
	h.presenceMu.Lock()
	public, private := h.buildPresenceBatch(map[int64]pendingPresence{
		5: {status: db.StatusInvisible, listening: song},
		6: {status: db.StatusOnline, listening: song},
	})
	h.presenceMu.Unlock()
	titles := func(raw []byte) map[int64]string {
		var f lisFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		out := map[int64]string{}
		for _, e := range f.Payload.Updates {
			out[e.UserID] = decodeListening(t, e.Listening)
		}
		return out
	}
	if got := titles(public); got[5] != "" || got[6] != "Secret" {
		t.Errorf("public batch = %v, want user 5 blanked and user 6 shown", got)
	}
	if got := titles(private[5]); got[5] != "Secret" {
		t.Errorf("subject's own batch = %v, want the truth for user 5", got)
	}
}

type readyListeningEntry struct {
	UserID     int64  `json:"user_id"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Player     string `json:"player"`
	StartedAt  int64  `json:"started_at"`
	DurationMS int64  `json:"duration_ms"`
}

func readyListeningFor(t *testing.T, h *Hub, database *db.DB, userID int64) ([]readyListeningEntry, map[string]any, []string) {
	t.Helper()
	raw, err := h.readyBytes(database, userID, nil)
	if err != nil {
		t.Fatalf("readyBytes: %v", err)
	}
	var env struct {
		Payload struct {
			Listening    []readyListeningEntry `json:"listening"`
			Capabilities map[string]any        `json:"capabilities"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if env.Payload.Listening == nil {
		t.Fatalf("ready has no listening array: %s", raw[:min(len(raw), 300)])
	}
	// Top-level key order must stay sorted (the head/tail splice contract).
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	var top map[string]json.RawMessage
	if err := dec.Decode(&top); err != nil {
		t.Fatal(err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(top["payload"], &payload); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	return env.Payload.Listening, env.Payload.Capabilities, keys
}

func TestReady_ListeningAndCapability(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	viewer := connect("lisreadyviewer", true)
	fan := connect("lisreadyfan", true)
	ghost := connect("lisreadyghost", true)

	got, caps, keys := readyListeningFor(t, h, database, viewer.userID)
	if len(got) != 0 {
		t.Fatalf("ready.listening = %+v, want empty", got)
	}
	if v, ok := caps["listening_activity"].(bool); !ok || !v {
		t.Errorf("capabilities.listening_activity = %v, want true", caps["listening_activity"])
	}
	if !slices.Contains(keys, "listening") || !slices.Contains(keys, "activities") || !slices.Contains(keys, "members") {
		t.Errorf("ready payload keys = %v, want listening beside activities and members", keys)
	}

	sendListening(t, h, fan, "Song")
	sendListening(t, h, ghost, "Secret Song")
	ghost.setLivePresence(db.StatusInvisible, nil, "")
	sendListening(t, h, viewer, "Mine")

	got, _, _ = readyListeningFor(t, h, database, viewer.userID)
	byUser := map[int64]readyListeningEntry{}
	for _, e := range got {
		byUser[e.UserID] = e
		if e.StartedAt <= 0 || e.DurationMS != 215000 || e.Artist != "Band" || e.Player != "Spotify" {
			t.Errorf("entry %+v is missing a field", e)
		}
	}
	if byUser[fan.userID].Title != "Song" || byUser[viewer.userID].Title != "Mine" {
		t.Errorf("viewer's ready.listening = %+v, want the fan and the viewer's own", got)
	}
	if _, leaked := byUser[ghost.userID]; leaked {
		t.Errorf("ready.listening lists the invisible user to another viewer: %+v", got)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].UserID >= got[i].UserID {
			t.Errorf("ready.listening not sorted by user_id: %+v", got)
		}
	}
	own, _, _ := readyListeningFor(t, h, database, ghost.userID)
	var ownTitle string
	for _, e := range own {
		if e.UserID == ghost.userID {
			ownTitle = e.Title
		}
	}
	if ownTitle != "Secret Song" {
		t.Errorf("the invisible user's own ready.listening = %+v, want their song", own)
	}
}

// ---------------------------------------------------------------------------
// The per-server switch (game_activity_enabled) covers songs too
// ---------------------------------------------------------------------------

func TestListeningPolicy_OffSweepsBothInOneFrameAndRefusesSets(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	both := connect("lispolboth", true)
	ghost := connect("lispolghost", true)
	songOnly := connect("lispolsong", true)
	watcher := connect("lispolwatch", true)
	settle(t, h)
	sendActivity(t, h, both, "Factorio")
	sendListening(t, h, both, "Song")
	sendListening(t, h, ghost, "Secret Song")
	ghost.setLivePresence(db.StatusInvisible, nil, "")
	sendListening(t, h, songOnly, "Tune")
	for _, c := range []*Client{both, ghost, songOnly, watcher} {
		drain(c.send)
	}

	saveGameActivitySwitch(t, h, database, false)

	for _, c := range []*Client{both, ghost, songOnly} {
		if lp := c.livePresence(); lp.activity != nil || lp.listening != nil {
			t.Fatalf("user %d keeps %+v after switching off", c.userID, lp)
		}
	}
	// One sequenced frame per visible user clears both values at once.
	seenByWatcher := drain(watcher.send)
	if got := presFramesIn(t, seenByWatcher, both.userID); len(got) != 1 || got[0] != (presSeen{db.StatusOnline, "", ""}) {
		t.Fatalf("watcher saw %+v for the game+song user, want one frame with both null", got)
	}
	if got := presFramesIn(t, seenByWatcher, songOnly.userID); len(got) != 1 || got[0].song != "" {
		t.Fatalf("watcher saw %+v for the song-only user, want one null", got)
	}
	// The invisible user's clear is on their own frame only.
	if got := presFramesIn(t, seenByWatcher, ghost.userID); len(got) != 0 {
		t.Fatalf("the invisible user's clear reached another member: %+v", got)
	}
	if got := presFramesOf(t, ghost, ghost.userID); len(got) != 1 || got[0] != (presSeen{db.StatusInvisible, "", ""}) {
		t.Fatalf("invisible self saw %+v, want one invisible presence with null", got)
	}

	drain(both.send)
	drain(ghost.send)
	h.limiter.Reset(context.Background(), auth.Key("listening", both.userID))
	// A set is refused with the same code, before the limiter (no budget used),
	// and a clear with nothing set is a silent no-op.
	for range 3 {
		sendListening(t, h, both, "Song")
		own := drain(both.send)
		if len(own) != 1 || activityErrCode(t, own[0]) != ErrCodeGameActivityDisabled {
			t.Fatalf("set while off answered %q, want GAME_ACTIVITY_DISABLED", own)
		}
	}
	sendListening(t, h, both, "")
	if frames := drain(both.send); len(frames) != 0 {
		t.Fatalf("a clear with nothing stored answered %q", frames)
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("a refused set or no-op clear broadcast %q", frames)
	}

	// Ready says false and lists nothing.
	got, caps, _ := readyListeningFor(t, h, database, watcher.userID)
	if caps["listening_activity"] != false || len(got) != 0 {
		t.Errorf("ready while off: capability %v, listening %+v, want false and empty", caps["listening_activity"], got)
	}

	// Back on: the refusals took no budget, so the first set is accepted.
	saveGameActivitySwitch(t, h, database, true)
	drain(both.send)
	drain(watcher.send)
	sendListening(t, h, both, "Song")
	if got := presFramesOf(t, watcher, both.userID); len(got) != 1 || got[0].song != "Song" {
		t.Fatalf("watcher saw %+v after switching on, want Song", got)
	}
	if _, caps, _ := readyListeningFor(t, h, database, watcher.userID); caps["listening_activity"] != true {
		t.Errorf("capabilities.listening_activity = %v, want true again", caps["listening_activity"])
	}
}

// The handler check only decides the reply; the flag read under presenceMu is
// what keeps a set that raced the sweep from surviving it.
func TestListeningPolicy_ApplyAfterSwitchDropsSet(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	player := connect("lispoldrop", true)
	watcher := connect("lispoldropwatch", true)
	settle(t, h)
	drain(watcher.send)

	h.gameActivity.on.Store(false)
	h.applyListening(player, &listeningActivity{Title: "S", Artist: "A", Player: "P", StartedAt: time.Now().UnixMilli()})
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if player.livePresence().listening != nil {
		t.Fatal("applyListening stored a set after the switch went off")
	}
	if frames := drain(watcher.send); len(frames) != 0 {
		t.Fatalf("a dropped set broadcast %q", frames)
	}

	// A clear is always applied.
	h.gameActivity.on.Store(true)
	h.applyListening(player, &listeningActivity{Title: "S", Artist: "A", Player: "P", StartedAt: time.Now().UnixMilli()})
	h.gameActivity.on.Store(false)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	drain(watcher.send)
	h.applyListening(player, nil)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if player.livePresence().listening != nil {
		t.Fatal("a clear was not applied while off")
	}
	if got := presFramesOf(t, watcher, player.userID); len(got) != 1 || got[0].song != "" {
		t.Fatalf("clear while off broadcast %+v, want one null", got)
	}
}

// A presence_update builds its events from the values it snapshotted at
// dispatch and emits them later. A sweep in between must not be undone by the
// older song, on the public frame or on the owner's own.
func TestListeningPolicy_PresenceUpdateAfterSweepCarriesNoSong(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	player := connect("lispolstale", true)
	ghost := connect("lispolstaleghost", true)
	watcher := connect("lispolstalewatch", true)
	settle(t, h)
	sendListening(t, h, player, "Song")
	sendListening(t, h, ghost, "Secret Song")
	stale := player.livePresence().listening
	staleGhost := ghost.livePresence().listening
	if stale == nil || staleGhost == nil {
		t.Fatal("setup: no song stored")
	}

	pubEvents := presenceEvents(player.userID, db.StatusDND, nil, nil, stale)
	ghostEvents := presenceEvents(ghost.userID, db.StatusInvisible, nil, nil, staleGhost)

	saveGameActivitySwitch(t, h, database, false)
	for _, c := range []*Client{player, ghost, watcher} {
		drain(c.send)
	}

	h.EmitEvents(context.Background(), append(pubEvents, ghostEvents...))
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := presFramesOf(t, watcher, player.userID); len(got) != 1 || got[0] != (presSeen{db.StatusDND, "", ""}) {
		t.Fatalf("watcher saw %+v for the status change, want dnd with null song", got)
	}
	if got := presFramesOf(t, ghost, ghost.userID); len(got) != 1 || got[0] != (presSeen{db.StatusInvisible, "", ""}) {
		t.Fatalf("invisible self saw %+v, want invisible with null song", got)
	}
}
