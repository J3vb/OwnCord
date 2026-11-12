package ws_test

// protocol_epoch1_contract_test.go — golden wire transcripts for protocol
// epoch 1, the wire every client up to and including v1.2.0-alpha.4 speaks.
//
// protocol_contract_test.go locks the message-type *vocabulary* (schema.json
// against the generated Go constants). It says nothing about what a frame of a
// given type actually contains, or about which frames a journey produces in
// which order. B2-2 adds a protocol epoch to the auth handshake; once that
// merges there is no way to go back and record what epoch 1 looked like, so
// this file drives the required journeys through the package's in-process hub
// harness and compares each journey's frame sequence against a JSON transcript
// under protocol/fixtures/epoch-1/.
//
// What the fixtures lock, and what they deliberately do not:
//
//   - Per connection, frames are compared IN ORDER. Cross-connection
//     interleaving is timing-dependent and is not part of the contract, so
//     each connection gets its own list and nothing relates the two.
//   - Volatile values (ids, seqs, timestamps, tokens) are replaced by typed
//     placeholders — "<id:number>", "<seq:number>", "<ts:string>",
//     "<token:string>" — before both writing and comparison. The type stays
//     visible so a field that changes from number to string still fails.
//     channel_id and role_id are NOT normalised: they are deterministic in a
//     freshly migrated database and are meaningful to the contract. The rule
//     keys off the field NAME, not the meaning of the value, so a bare "id"
//     (ready.channels[].id, a request's own id) and active_channel_id ARE
//     normalised even where that value is in fact a channel id. That is by
//     design, not an oversight: only the two exact names are exempt. It also
//     costs one relationship: chat_send_ok echoes the id of the chat_send it
//     answers, and both become "<id:string>", so the fixture pins that the
//     field is present and a string but not that the two match.
//     Everything else — extra keys, missing keys, renames, enum values, null
//     vs absent — is compared verbatim. That is the drift these exist to catch.
//   - Optional fields are recorded in BOTH forms. alice carries a display
//     name, an avatar, an about text, a custom status and an E2EE identity
//     public key, and her voice_e2ee_announce carries a signature; bob carries
//     none of them and announces without one. A field frozen only as
//     null/absent would let a rename or a retype through unseen, and a field
//     frozen only as present would leave the null form — the one a client must
//     still handle — unfrozen. So fresh-connect records BOTH handshakes: on
//     alice's connection auth_ok.user and member_join.user carry every profile
//     field, on bob's they carry the nulls (auth_ok) and the omissions
//     (member_join drops display_name and identity_public_key). auth_ok is the
//     frame B2-2 changes, which is why it is the one recorded twice.
//   - Only the journey's own frames are recorded. The connect handshake
//     (auth_ok / ready / member_join / presence_batch) and any channel_focus setup
//     are drained without recording, EXCEPT in fresh-connect, resume-replay
//     and auth-failure, where the handshake *is* the journey. Otherwise every
//     fixture would carry its own copy of the ready payload and one ready
//     change would rewrite eleven files.
//   - A recorded connection closes its frame list with a ping/pong barrier
//     (two exceptions, both named below), and where a frame must produce
//     nothing at all (mark_read, the sender's own typing_start) that same pair
//     doubles as the absence proof.
//     pong is a direct reply on the normal-priority queue, so anything queued
//     ahead of it there — or on the high-priority queue — arrives first and
//     fails as `expected "pong", got "X"`. A LOW-priority frame (typing,
//     presence_update) pending at the same instant is the one thing pong may
//     overtake (writePump, serve_pumps.go:83-101); no journey is affected, because
//     every barrier here is sent on a connection that is otherwise idle.
//     Without the barrier a frame emitted after a journey's last read would
//     never be recorded and the fixture would still pass — exactly the drift
//     this file exists to catch. Two connections take it differently:
//     auth-failure has no session left to ping, so the server's close after
//     auth_error is the proof nothing follows; and resume-replay's "b" barriers
//     where its recording window ends rather than where the journey does (the
//     comment there says why moving it would be a flake, not a fix).
// Regenerate with:
//
//	go test ./ws -run TestEpoch1Fixtures -update
//
// then read the diff. A fixture change is a protocol change; it needs the same
// scrutiny as editing protocol/schema.json.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

var updateFixtures = flag.Bool("update", false, "rewrite protocol/fixtures/epoch-1 from the live server")

// frameDeadline bounds every individual read and write. A journey that hangs
// must fail with a named frame, not stall CI until the package timeout.
const frameDeadline = 5 * time.Second

// authFailureCloseReason is the reason string the server pairs with close code
// 1008 when the handshake is rejected (serve.go:128).
const authFailureCloseReason = "authentication failed"

// ─── fixture model ───────────────────────────────────────────────────────────

type wireFrame struct {
	Dir   string         `json:"dir"` // "c2s" or "s2c"
	Frame map[string]any `json:"frame"`
}

type wireTranscript struct {
	Journey     string                 `json:"journey"`
	Connections map[string][]wireFrame `json:"connections"`
}

func newTranscript(journey string) *wireTranscript {
	return &wireTranscript{Journey: journey, Connections: map[string][]wireFrame{}}
}

func (tr *wireTranscript) add(conn, dir string, frame map[string]any) {
	tr.Connections[conn] = append(tr.Connections[conn], wireFrame{Dir: dir, Frame: frame})
}

// ─── normalisation ───────────────────────────────────────────────────────────

// volatileClass classifies a JSON key whose value changes run to run. The
// returned class becomes the placeholder prefix; ok is false for every key
// whose value must be compared verbatim.
func volatileClass(key string) (string, bool) {
	switch {
	case key == "seq", key == "last_seq":
		return "seq", true
	case key == "channel_id", key == "role_id":
		// Deterministic in a fresh database and load-bearing for the contract.
		return "", false
	case key == "id", strings.HasSuffix(key, "_id"):
		return "id", true
	case key == "direct_url":
		// The LiveKit server address, deployment-specific: a loopback test
		// server's ephemeral port otherwise makes the transcript unstable.
		return "url", true
	case strings.HasSuffix(key, "_at"), key == "timestamp", strings.HasSuffix(key, "_timestamp"), key == "ts", key == "last_seen":
		return "ts", true
	case strings.Contains(key, "token"):
		return "token", true
	}
	return "", false
}

// jsonTypeOf names the JSON type of a decoded value so the placeholder keeps it
// visible: a field that flips from number to string is still a fixture diff.
func jsonTypeOf(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "bool"
	case json.Number:
		return "number"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// normaliseValue rewrites every volatile value in v (recursively, through both
// objects and arrays) to its typed placeholder.
func normaliseValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if class, volatile := volatileClass(k); volatile {
				out[k] = "<" + class + ":" + jsonTypeOf(val) + ">"
				continue
			}
			out[k] = normaliseValue(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = normaliseValue(t[i])
		}
		return out
	default:
		return v
	}
}

func normaliseTranscript(tr *wireTranscript) *wireTranscript {
	out := newTranscript(tr.Journey)
	for name, frames := range tr.Connections {
		normalised := make([]wireFrame, len(frames))
		for i, f := range frames {
			m, _ := normaliseValue(f.Frame).(map[string]any)
			normalised[i] = wireFrame{Dir: f.Dir, Frame: m}
		}
		out.Connections[name] = normalised
	}
	return out
}

// decodeFrame parses one wire frame. UseNumber keeps integers exact, so a
// regenerated fixture never turns 2147483647 into 2.147483647e+09.
func decodeFrame(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("decoding frame %s: %v", raw, err)
	}
	return m
}

// canonicalJSON renders v with sorted keys and stable two-space indentation,
// so key order never enters the comparison. HTML escaping is off: it is on by
// default in encoding/json (json.MarshalIndent included), and with it every
// placeholder would be written as "\u003cid:number\u003e" rather than
// "<id:number>" — in a file whose whole job is to be read by a human
// reviewing a protocol change.
func canonicalJSON(t *testing.T, v any) string {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatalf("marshalling fixture value: %v", err)
	}
	return strings.TrimRight(buf.String(), "\n")
}

// ─── fixture I/O ─────────────────────────────────────────────────────────────

// epoch1FixtureDir resolves protocol/fixtures/epoch-1 relative to THIS file
// (ws/ -> Server/ -> repo root -> protocol/), never from the working directory
// `go test` happened to be invoked from. Same rule as loadProtocolSchema.
func epoch1FixtureDir(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed to resolve test file path")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "protocol", "fixtures", "epoch-1")
}

// verify writes the transcript under -update, and otherwise compares it with
// the committed fixture frame by frame.
func (tr *wireTranscript) verify(t *testing.T) {
	t.Helper()
	dir := epoch1FixtureDir(t)
	path := filepath.Join(dir, tr.Journey+".json")
	got := normaliseTranscript(tr)

	if *updateFixtures {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("journey %q: creating %s: %v", tr.Journey, dir, err)
		}
		body := append([]byte(canonicalJSON(t, got)), '\n')
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatalf("journey %q: writing %s: %v", tr.Journey, path, err)
		}
		t.Logf("journey %q: wrote %s", tr.Journey, path)
		return
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("journey %q: reading %s: %v\nregenerate with: go test ./ws -run TestEpoch1Fixtures -update",
			tr.Journey, path, err)
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var want wireTranscript
	if err := dec.Decode(&want); err != nil {
		t.Fatalf("journey %q: parsing %s: %v", tr.Journey, path, err)
	}
	compareTranscripts(t, &want, got)
}

func compareTranscripts(t *testing.T, want, got *wireTranscript) {
	t.Helper()
	if want.Journey != got.Journey {
		t.Errorf("journey %q: fixture records journey %q", got.Journey, want.Journey)
	}
	names := map[string]struct{}{}
	for n := range want.Connections {
		names[n] = struct{}{}
	}
	for n := range got.Connections {
		names[n] = struct{}{}
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)

	for _, name := range sorted {
		w, g := want.Connections[name], got.Connections[name]
		for i := 0; i < len(w) || i < len(g); i++ {
			switch {
			case i >= len(g):
				t.Errorf("journey %q connection %q: frame %d missing (fixture has %d frames, server sent %d)\nfixture:\n%s",
					got.Journey, name, i, len(w), len(g), canonicalJSON(t, w[i]))
			case i >= len(w):
				t.Errorf("journey %q connection %q: frame %d unexpected (fixture has %d frames, server sent %d)\nserver:\n%s",
					got.Journey, name, i, len(w), len(g), canonicalJSON(t, g[i]))
			default:
				wc, gc := canonicalJSON(t, w[i]), canonicalJSON(t, g[i])
				if wc != gc {
					t.Errorf("journey %q connection %q: frame %d differs\nfixture:\n%s\nserver:\n%s\nregenerate with: go test ./ws -run TestEpoch1Fixtures -update",
						got.Journey, name, i, wc, gc)
				}
			}
		}
	}
}

// ─── in-process hub harness ──────────────────────────────────────────────────

// epochRig is the package's usual end-to-end wiring (full migrations, real
// hub, httptest WebSocket server) collected into one place so eleven journeys
// do not repeat it. It is not a new abstraction over the harness — it is the
// same calls reconnect_db_test.go and coverage_helpers_test.go make.
type epochRig struct {
	hub   *ws.Hub
	db    *db.DB
	svc   *service.Services
	wsURL string
	tr    *wireTranscript
}

// newEpochRig builds the rig. configure, when given, adjusts the hub options
// before the hub is built — for the one journey (server-admin-broadcasts) that
// needs a collaborator the other journeys must not have, because wiring it in
// everywhere would change what auth_ok carries in every fixture.
func newEpochRig(t *testing.T, journey string, configure ...func(*ws.HubOptions)) *epochRig {
	t.Helper()

	database := openMigratedDB(t)

	limiter := auth.NewRateLimiter()

	// A LiveKit client so voice_join clears the "voice not configured" guard
	// and the externally-managed reachability probe. Token signing is local;
	// the stub only answers the probe.
	lk := healthyLiveKitClient(t)
	svc := service.New(database, limiter)
	opts := ws.HubOptions{DB: database, Limiter: limiter, Services: svc, LiveKit: lk}
	for _, f := range configure {
		f(&opts)
	}
	hub := newTestHubWith(t, opts)

	go hub.Run()
	t.Cleanup(func() { hub.Stop() })

	srv := httptest.NewServer(ws.ServeWS(hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)

	return &epochRig{
		hub:   hub,
		db:    database,
		svc:   svc,
		wsURL: "ws" + strings.TrimPrefix(srv.URL, "http"),
		tr:    newTranscript(journey),
	}
}

// seedUser creates a Member-role user (role 4 carries READ/SEND/REACT plus
// CONNECT_VOICE and SPEAK — see migrations 005 and 007) and an active session,
// returning the user id and the raw session token.
func (r *epochRig) seedUser(t *testing.T, username string) (int64, string) {
	t.Helper()
	ctx := context.Background()
	userID, err := r.db.CreateUser(ctx, username, "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := r.db.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession(%s): %v", username, err)
	}
	return userID, token
}

// fillAliceProfile sets every optional profile field on alice, so the fixtures
// record their present form and not just their null/absent one. bob is left
// bare on purpose — that is how both forms end up frozen. The values are
// obviously test data; the avatar is an https URL because that is the only
// shape the REST profile path accepts (api/profile_handler.go:120).
func (r *epochRig) fillAliceProfile(t *testing.T, userID int64) {
	t.Helper()
	ctx := context.Background()
	avatar := "https://fixtures.invalid/alice-avatar.png"
	displayName := "Alice Fixture"
	about := "fixture profile text"
	customStatus := "fixture custom status"
	// A long-term E2EE identity key, base64 of an obvious test string. It is
	// NOT normalised — the rule replaces keys containing "token", and
	// identity_public_key is not one — so the fixture pins the value verbatim.
	identityKey := "YWxpY2UtaWRlbnRpdHktcHVibGljLWtleS1maXh0dXJl"
	if err := r.db.UpdateUserProfile(ctx, userID, "alice", &avatar, &displayName, &about, nil, nil); err != nil {
		t.Fatalf("UpdateUserProfile(alice): %v", err)
	}
	if err := r.db.UpdateUserCustomStatus(ctx, userID, &customStatus); err != nil {
		t.Fatalf("UpdateUserCustomStatus(alice): %v", err)
	}
	if err := r.db.UpdateUserIdentityKey(ctx, userID, &identityKey); err != nil {
		t.Fatalf("UpdateUserIdentityKey(alice): %v", err)
	}
}

// seedBaseline gives every journey the same starting database: two members,
// one text channel (id 1) and one voice channel (id 2). Channel ids are not
// normalised, so keeping the seed identical keeps them readable across
// fixtures.
//
// alice fills in every optional profile field and bob fills in none, so each
// omitempty/nullable field is frozen in BOTH forms: present (where a rename or
// a retype is visible) and absent. Freezing only the absent form would let
// display_name or identity_public_key be renamed, retyped or dropped without a
// single fixture moving.
func (r *epochRig) seedBaseline(t *testing.T) (aliceID, bobID int64, aliceTok, bobTok string) {
	t.Helper()
	aliceID, aliceTok = r.seedUser(t, "alice")
	bobID, bobTok = r.seedUser(t, "bob")
	r.fillAliceProfile(t, aliceID)
	ctx := context.Background()
	textID, err := r.db.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(general): %v", err)
	}
	voiceID, err := r.db.CreateChannel(ctx, "Voice", "voice", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel(Voice): %v", err)
	}
	// channel_id is the one id the fixtures record verbatim, so pin the seed's
	// assignment rather than letting a fixture quietly re-anchor to new numbers.
	if textID != textChannelID || voiceID != voiceChannelID {
		t.Fatalf("seed channel ids = (%d, %d), want (%d, %d) — the fixtures record channel_id verbatim",
			textID, voiceID, textChannelID, voiceChannelID)
	}
	return aliceID, bobID, aliceTok, bobTok
}

const (
	textChannelID  = 1
	voiceChannelID = 2
)

// ─── connection helpers ──────────────────────────────────────────────────────

type wsConn struct {
	t       *testing.T
	name    string
	tr      *wireTranscript
	conn    *websocket.Conn
	record  bool
	lastSeq uint64
}

// connectPair dials and authenticates alice ("a") then bob ("b"), and has a
// consume the member_join and presence_batch that b's connect produced, so
// the journey records from a quiet baseline.
func (r *epochRig) connectPair(t *testing.T, aliceTok, bobTok string) (a, b *wsConn) {
	t.Helper()
	a, b = r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")
	return a, b
}

// recordedPair is connectPair followed by recording on both sockets. Given a
// channel it first focuses it on both: a without a barrier, b with one so
// b's subscription is live before a acts.
func (r *epochRig) recordedPair(t *testing.T, aliceTok, bobTok string, focusChannel ...int64) (a, b *wsConn) {
	t.Helper()
	a, b = r.connectPair(t, aliceTok, bobTok)
	for _, ch := range focusChannel {
		a.focus(ch, false)
		b.focus(ch, true)
	}
	a.record, b.record = true, true
	return a, b
}

// dial opens a WebSocket to the rig and registers its close in t.Cleanup —
// the ws package runs goleak.VerifyTestMain, so nothing may outlive the test.
func (r *epochRig) dial(t *testing.T, name string) *wsConn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), frameDeadline)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, r.wsURL, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("conn %q: websocket.Dial: %v", name, err)
	}
	// Headroom, not a requirement: the largest frame these journeys produce
	// (ready) is ~1.5 KiB, well inside coder/websocket's 32 KiB default. A
	// fixture run must fail on a frame that changed, not on a read limit, if a
	// future seed or a fatter ready pushes past it.
	conn.SetReadLimit(1 << 20)
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	return &wsConn{t: t, name: name, tr: r.tr, conn: conn}
}

func (c *wsConn) send(frame map[string]any) {
	c.t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		c.t.Fatalf("conn %q: marshalling %v: %v", c.name, frame, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), frameDeadline)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, raw); err != nil {
		c.t.Fatalf("conn %q: writing %s: %v", c.name, raw, err)
	}
	if c.record {
		c.tr.add(c.name, "c2s", decodeFrame(c.t, raw))
	}
}

// readRaw takes exactly one frame, bounded by frameDeadline, and tracks the
// highest seq seen so a resume can replay from it the way a real client does.
// It never records; use read for that.
func (c *wsConn) readRaw() map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), frameDeadline)
	defer cancel()
	_, raw, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("conn %q: read: %v", c.name, err)
	}
	frame := decodeFrame(c.t, raw)
	if n, ok := frame["seq"].(json.Number); ok {
		if v, err := n.Int64(); err == nil && v > 0 && uint64(v) > c.lastSeq {
			c.lastSeq = uint64(v)
		}
	}
	return frame
}

func (c *wsConn) read() map[string]any {
	c.t.Helper()
	frame := c.readRaw()
	if c.record {
		c.tr.add(c.name, "s2c", frame)
	}
	return frame
}

// expect reads one frame and asserts its envelope type.
func (c *wsConn) expect(msgType string) map[string]any {
	c.t.Helper()
	frame := c.read()
	if got := frame["type"]; got != msgType {
		c.t.Fatalf("conn %q: expected %q, got %q: %s", c.name, msgType, got, canonicalJSON(c.t, frame))
	}
	return frame
}

// expectEither reads two frames that reach this connection in either order and
// records them in the one canonical order given (first, then second). It is for
// a pair whose relative order is a race inside the server, not a contract: a
// direct per-user send from a handler against a broadcast that takes the hub's
// fan-out loop. Anything other than exactly that pair fails.
func (c *wsConn) expectEither(first, second string) {
	c.t.Helper()
	was := c.record
	c.record = false
	f1, f2 := c.read(), c.read()
	c.record = was
	got := map[any]map[string]any{f1["type"]: f1, f2["type"]: f2}
	if len(got) != 2 || got[first] == nil || got[second] == nil {
		c.t.Fatalf("conn %q: expected %q and %q in either order, got %q then %q",
			c.name, first, second, f1["type"], f2["type"])
	}
	if c.record {
		c.tr.add(c.name, "s2c", got[first])
		c.tr.add(c.name, "s2c", got[second])
	}
}

// barrier closes a connection's recorded frame list: it sends ping and asserts
// the next frame is pong. pong is a direct reply, so any frame the server
// queued before it arrives first and fails as `expected "pong", got "X"` —
// which is what makes a trailing frame a fixture failure instead of a frame
// nobody ever reads. The pair is recorded; it is part of the transcript.
//
// Ping budget: handlePingV2 rate-limits ping to 2 per second per USER
// (handlers_ping.go:14) and drops the excess SILENTLY, which would turn a
// third ping into a 5 s read-deadline failure rather than an error frame. No
// journey may spend more than two per user per second: focus(_, true) spends
// one and this spends one, which is the ceiling six connections already sit
// on — bob in chat-send-fanout, chat-edit-delete, reaction-add-remove, typing
// and resume-replay (a focus barrier plus a closing one), and alice in ping
// (the journey's own pair). Need another? Give that user a second connection,
// do not add a sleep.
func (c *wsConn) barrier() {
	c.t.Helper()
	c.send(map[string]any{"type": "ping", "payload": map[string]any{}})
	c.expect("pong")
}

// expectClosed asserts the server hung up rather than sending another frame,
// with the close code and reason the handshake failure path uses. It is
// auth-failure's barrier: there is no session left to ping, so the close
// itself (serve.go:128 — 1008 policy violation, "authentication failed") is
// the proof that auth_error is the last thing on that socket. Both halves are
// part of the epoch-1 contract, so both are asserted here rather than only the
// code.
func (c *wsConn) expectClosed() {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), frameDeadline)
	defer cancel()
	_, raw, err := c.conn.Read(ctx)
	if err == nil {
		c.t.Fatalf("conn %q: expected the server to close, got frame %s", c.name, raw)
	}
	var closeErr websocket.CloseError
	if !errors.As(err, &closeErr) {
		c.t.Fatalf("conn %q: expected a WebSocket close, got %v", c.name, err)
	}
	if closeErr.Code != websocket.StatusPolicyViolation || closeErr.Reason != authFailureCloseReason {
		c.t.Fatalf("conn %q: close = %v %q, want %v %q", c.name,
			closeErr.Code, closeErr.Reason, websocket.StatusPolicyViolation, authFailureCloseReason)
	}
}

// drain reads the named frames without recording them — journey setup, not
// journey content. Naming them (rather than counting) keeps the setup honest:
// an unexpected frame fails here instead of shifting the transcript.
func (c *wsConn) drain(types ...string) {
	c.t.Helper()
	was := c.record
	c.record = false
	for _, ty := range types {
		c.expect(ty)
	}
	c.record = was
}

// authenticate sends the auth frame and drains the fresh-connect handshake
// (auth_ok, ready, and the member_join + presence_batch this first-ever
// connect broadcasts to every client, itself included).
func (c *wsConn) authenticate(token string) {
	c.t.Helper()
	was := c.record
	c.record = false
	c.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-" + c.name,
		"payload": map[string]any{"token": token, "last_seq": 0},
	})
	c.drain("auth_ok", "ready", "member_join", "presence_batch")
	c.record = was
}

// focus subscribes the connection to a channel's topic and, for an observer
// whose subscription must be live before another connection acts, waits for a
// ping/pong round trip. Frames on one connection are handled in order, so the
// actor needs no barrier for its own focus.
func (c *wsConn) focus(channelID int64, barrier bool) {
	c.t.Helper()
	was := c.record
	c.record = false
	c.send(map[string]any{
		"type":    "channel_focus",
		"payload": map[string]any{"channel_id": channelID},
	})
	if barrier {
		c.barrier()
	}
	c.record = was
}

// ─── journeys ────────────────────────────────────────────────────────────────

type epochJourney struct {
	name string
	run  func(t *testing.T, r *epochRig)
}

// journeyHubOptions adjusts the hub options for the named journeys only.
var journeyHubOptions = map[string]func(*ws.HubOptions){
	"server-admin-broadcasts": configureUploadFileTypes,
}

func TestEpoch1Fixtures(t *testing.T) {
	journeys := []epochJourney{
		{"fresh-connect", journeyFreshConnect},
		{"auth-failure", journeyAuthFailure},
		{"ping", journeyPing},
		{"chat-send-fanout", journeyChatSendFanout},
		{"chat-edit-delete", journeyChatEditDelete},
		{"reaction-add-remove", journeyReactionAddRemove},
		{"typing", journeyTyping},
		{"channel-activity", journeyChannelActivity},
		{"mark-read", journeyMarkRead},
		{"mark-unread", journeyMarkUnread},
		{"dm-send", journeyDMSend},
		{"dm-request", journeyDMRequest},
		{"dm-request-ignored", journeyDMRequestIgnored},
		{"resume-replay", journeyResumeReplay},
		{"voice-join-e2ee-leave", journeyVoiceJoinE2EELeave},
		{"voice-watch", journeyVoiceWatch},
		{"voice-self-state", journeyVoiceSelfState},
		{"voice-moderation", journeyVoiceModeration},
		{"voice-moderation-move-kick", journeyVoiceModerationMoveKick},
		{"voice-token-refresh", journeyVoiceTokenRefresh},
		{"call-ring-decline", journeyCallRingDecline},
		{"voice-mod-denied", journeyVoiceModDenied},
		{"chat-forward-pin", journeyChatForwardPin},
		{"chat-poll", journeyChatPoll},
		{"chat-forum-post", journeyChatForumPost},
		{"chat-bulk-delete", journeyChatBulkDelete},
		{"mention-count-nsfw-ack", journeyMentionCountNSFWAck},
		{"chat-command-unknown", journeyChatCommandUnknown},
		{"channel-crud", journeyChannelCRUD},
		{"dm-open-close", journeyDMOpenClose},
		{"server-admin-broadcasts", journeyServerAdminBroadcasts},
		{"moderation-queue", journeyModerationQueue},
		{"role-change", journeyRoleChange},
		{"role-edit", journeyRoleEdit},
		{"user-update", journeyUserUpdate},
		{"member-ban", journeyMemberBan},
		{"member-timeout", journeyMemberTimeout},
	}
	for _, j := range journeys {
		t.Run(j.name, func(t *testing.T) {
			t.Parallel()
			var configure []func(*ws.HubOptions)
			if f, ok := journeyHubOptions[j.name]; ok {
				configure = append(configure, f)
			}
			rig := newEpochRig(t, j.name, configure...)
			j.run(t, rig)
			rig.tr.verify(t)
		})
	}
}
