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
//     (auth_ok / ready / member_join / presence) and any channel_focus setup
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
//   - One position genuinely is not ordered by the server: a voice joiner's own
//     voice_state arrives on the hub's asynchronous broadcast queue while the
//     rest of its join burst is written directly by the handler goroutine. That
//     frame is recorded on the peer's connection instead — see expectJoinBurst.
//
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
	"github.com/J3vb/OwnCord/Server/config"
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
	case strings.HasSuffix(key, "_at"), key == "timestamp", key == "ts", key == "last_seen":
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
	db    *db.DB
	wsURL string
	tr    *wireTranscript
}

func newEpochRig(t *testing.T, journey string) *epochRig {
	t.Helper()

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	limiter := auth.NewRateLimiter()

	// A LiveKit client so voice_join clears the "voice not configured" guard.
	// The join token is minted locally; no LiveKit process is contacted.
	lk, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-12345",
		LiveKitAPISecret: "test-api-secret-67890abcdef",
		LiveKitURL:       "ws://localhost:7880",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	hub := newTestHubWith(t, ws.HubOptions{
		DB: database, Limiter: limiter,
		Services: service.New(database, limiter), LiveKit: lk,
	})

	go hub.Run()
	t.Cleanup(func() { hub.Stop() })

	srv := httptest.NewServer(ws.ServeWS(hub, database, []string{"*"}, 0))
	t.Cleanup(srv.Close)

	return &epochRig{
		db:    database,
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
	if err := r.db.UpdateUserProfile(ctx, userID, "alice", &avatar, &displayName, &about); err != nil {
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
// (auth_ok, ready, and the member_join + presence this connect broadcasts to
// every client, itself included).
func (c *wsConn) authenticate(token string) {
	c.t.Helper()
	was := c.record
	c.record = false
	c.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-" + c.name,
		"payload": map[string]any{"token": token, "last_seq": 0},
	})
	c.drain("auth_ok", "ready", "member_join", "presence")
	c.record = was
}

// expectJoinBurst reads a voice_join's reply burst — one more frame than
// `want` names — and records only the frames the server orders.
//
// A joiner's OWN voice_state reaches it through the hub's asynchronous
// broadcast queue (broadcastVoiceEvent -> h.broadcast -> deliverBroadcast on
// the hub goroutine) while voice_token, the existing participants' relayed
// voice_state frames and voice_config are written straight to its send queue
// by the handler goroutine. Nothing orders the two against each other: under
// -tags deadlock a joiner's own voice_state was observed arriving after
// voice_config roughly once in thirty runs. Its position on THIS socket is
// therefore not part of the contract and is not recorded — the same frame is
// recorded on the peer's connection, where it is the only thing in flight and
// its position is well defined. The direct sends keep their relative order
// (one goroutine, program order), and `want` asserts it.
func (c *wsConn) expectJoinBurst(selfUserID int64, want ...string) {
	c.t.Helper()
	var got []string
	skipped := false
	for i := 0; i < len(want)+1; i++ {
		frame := c.readRaw()
		ty, _ := frame["type"].(string)
		if !skipped && ty == "voice_state" && framePayloadUserID(c.t, frame) == selfUserID {
			skipped = true
			continue
		}
		if c.record {
			c.tr.add(c.name, "s2c", frame)
		}
		got = append(got, ty)
	}
	if !skipped {
		c.t.Fatalf("conn %q: join burst %v carried no voice_state for user %d", c.name, got, selfUserID)
	}
	if len(got) != len(want) {
		c.t.Fatalf("conn %q: join burst %v, want %v", c.name, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			c.t.Fatalf("conn %q: join burst %v, want %v", c.name, got, want)
		}
	}
}

// framePayloadUserID reads payload.user_id, or 0 when absent.
func framePayloadUserID(t *testing.T, frame map[string]any) int64 {
	t.Helper()
	payload, _ := frame["payload"].(map[string]any)
	n, ok := payload["user_id"].(json.Number)
	if !ok {
		return 0
	}
	v, err := n.Int64()
	if err != nil {
		return 0
	}
	return v
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

func TestEpoch1Fixtures(t *testing.T) {
	journeys := []epochJourney{
		{"fresh-connect", journeyFreshConnect},
		{"auth-failure", journeyAuthFailure},
		{"ping", journeyPing},
		{"chat-send-fanout", journeyChatSendFanout},
		{"chat-edit-delete", journeyChatEditDelete},
		{"reaction-add-remove", journeyReactionAddRemove},
		{"typing", journeyTyping},
		{"mark-read", journeyMarkRead},
		{"dm-send", journeyDMSend},
		{"resume-replay", journeyResumeReplay},
		{"voice-join-e2ee-leave", journeyVoiceJoinE2EELeave},
	}
	for _, j := range journeys {
		t.Run(j.name, func(t *testing.T) {
			rig := newEpochRig(t, j.name)
			j.run(t, rig)
			rig.tr.verify(t)
		})
	}
}

// journeyFreshConnect records the whole handshake — auth, auth_ok, ready, and
// the member_join + presence a connect broadcasts (which the connecting client
// receives too) — TWICE, once per kind of account.
//
// alice has every optional profile field set; bob has none. Recording only
// alice would freeze auth_ok.user and member_join.user in their populated form
// alone, so a rename, a retype or a dropped null on display_name, about,
// custom_status, avatar or identity_public_key would move no fixture. auth_ok
// is the frame B2-2 edits, which makes it the last one to leave half-frozen.
//
// bob's connect is also observed on alice's socket, which is idle by then: the
// two broadcasts reach her through the hub's per-client FIFO in the order they
// were sequenced, so her reads stay deterministic. One ping each, well inside
// the per-user budget (see barrier).
func journeyFreshConnect(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a := r.dial(t, "a")
	a.record = true
	// The real client stamps a correlation id on every frame it sends,
	// auth included (ws.ts send()); the server ignores it here.
	a.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-alice",
		"payload": map[string]any{"token": aliceTok, "last_seq": 0},
	})
	a.expect("auth_ok")
	a.expect("ready")
	a.expect("member_join")
	a.expect("presence")

	// bob, recorded: the same five frames with the bare user object — nulls
	// for avatar/display_name/about/custom_status, identity_public_key omitted.
	b := r.dial(t, "b")
	b.record = true
	b.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-bob",
		"payload": map[string]any{"token": bobTok, "last_seq": 0},
	})
	b.expect("auth_ok")
	b.expect("ready")
	b.expect("member_join")
	b.expect("presence")

	// bob's connect as an already-connected client sees it.
	a.expect("member_join")
	a.expect("presence")

	a.barrier()
	b.barrier()
}

// journeyAuthFailure records the rejection an unknown session token earns.
// The two sibling rejections share the frame shape and differ only in the
// message string: "invalid message" (unparseable first frame) and "first
// message must be auth" (a first frame of any other type).
//
// This is the one journey with no ping/pong barrier: there is no session to
// ping. The server closes the socket right after the frame (serve.go:126-129),
// so the close is the proof that auth_error is the last thing said — and an
// extra frame slipped in ahead of it fails expectClosed rather than passing
// unrecorded.
func journeyAuthFailure(t *testing.T, r *epochRig) {
	r.seedBaseline(t)

	a := r.dial(t, "a")
	a.record = true
	a.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-rejected",
		"payload": map[string]any{"token": "not-a-real-session-token", "last_seq": 0},
	})
	a.expect("auth_error")
	a.expectClosed()
}

// journeyPing records the heartbeat round trip twice: the second pair is the
// barrier proving nothing follows the first pong. Two is the whole per-second
// ping budget (see barrier), so this journey sits exactly on the ceiling.
func journeyPing(t *testing.T, r *epochRig) {
	_, _, aliceTok, _ := r.seedBaseline(t)

	a := r.dial(t, "a")
	a.authenticate(aliceTok)

	a.record = true
	a.send(map[string]any{"type": "ping", "payload": map[string]any{}})
	a.expect("pong")
	a.barrier()
}

// journeyChatSendFanout records a channel message: the sender's direct
// chat_send_ok reply plus the sequenced chat_message every focused client in
// the channel receives, sender included.
func journeyChatSendFanout(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence") // b's connect, observed by a
	a.focus(textChannelID, false)
	b.focus(textChannelID, true)

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-chat-send-1",
		"payload": map[string]any{"channel_id": textChannelID, "content": "hello epoch one"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	b.expect("chat_message")
	a.barrier()
	b.barrier()
}

// journeyChatEditDelete records the two mutations of an existing message.
// Neither carries a direct reply — the broadcast is the whole answer, so the
// author learns the outcome the same way every other client does.
func journeyChatEditDelete(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	msgID, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "original text", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence")
	a.focus(textChannelID, false)
	b.focus(textChannelID, true)

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "chat_edit",
		"id":      "req-chat-edit-1",
		"payload": map[string]any{"message_id": msgID, "content": "edited text"},
	})
	a.expect("chat_edited")
	b.expect("chat_edited")

	a.send(map[string]any{
		"type":    "chat_delete",
		"id":      "req-chat-delete-1",
		"payload": map[string]any{"message_id": msgID},
	})
	a.expect("chat_deleted")
	b.expect("chat_deleted")
	a.barrier()
	b.barrier()
}

// journeyReactionAddRemove records both halves of a reaction. Add and remove
// share one frame type and differ only in the action field.
func journeyReactionAddRemove(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	msgID, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "react to me", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence")
	a.focus(textChannelID, false)
	b.focus(textChannelID, true)

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "reaction_add",
		"id":      "req-reaction-add-1",
		"payload": map[string]any{"message_id": msgID, "emoji": "👍"},
	})
	a.expect("reaction_update")
	b.expect("reaction_update")

	a.send(map[string]any{
		"type":    "reaction_remove",
		"id":      "req-reaction-remove-1",
		"payload": map[string]any{"message_id": msgID, "emoji": "👍"},
	})
	a.expect("reaction_update")
	b.expect("reaction_update")
	a.barrier()
	b.barrier()
}

// journeyTyping records the typing indicator, which is delivered on the
// low-priority queue and excludes its sender. The ping/pong pair on "a" is the
// absence proof: the typist must not see its own typing frame.
//
// "a" focuses the channel first, exactly like the other fan-out journeys. That
// is what makes the absence proof mean anything: a live client joins a
// channel's topic only when it focuses that channel (handleChannelFocusV2,
// handlers_presence.go:97, whose SetChannelID result the hub applies), so an
// unfocused "a" could not receive the frame no matter what excludeUserID did,
// and the barrier would be proving the subscription was missing rather than
// that the server excludes the sender.
func journeyTyping(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence")
	a.focus(textChannelID, false)
	b.focus(textChannelID, true)

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "typing_start",
		"payload": map[string]any{"channel_id": textChannelID},
	})
	b.expect("typing")
	a.barrier()
	b.barrier()
}

// journeyMarkRead records the one client→server frame that answers with
// nothing at all. The ping/pong pair proves the silence.
func journeyMarkRead(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, _ := r.seedBaseline(t)
	if _, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "unread", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	a := r.dial(t, "a")
	a.authenticate(aliceTok)

	a.record = true
	a.send(map[string]any{
		"type":    "mark_read",
		"payload": map[string]any{"channel_id": textChannelID},
	})
	a.barrier()
}

// journeyDMSend records a direct message. DM traffic is addressed to the
// participant ids rather than a channel topic, so neither side needs focus,
// and the whole fan-out is synchronous on the sender's connection.
func journeyDMSend(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence")

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-dm-send-1",
		"payload": map[string]any{"channel_id": dmChannel.ID, "content": "hello over dm"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	b.expect("chat_message")
	a.barrier()
	b.barrier()
}

// journeyResumeReplay records the reconnect handshake: the actor drops, misses
// two sequenced events, and resumes with last_seq — earning auth_ok with
// replay_source "buffer" followed by the replay burst, then its own live
// come-back-online presence.
func journeyResumeReplay(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence")
	b.focus(textChannelID, true)

	lastSeq := a.lastSeq
	if lastSeq == 0 {
		t.Fatal("conn \"a\" saw no sequenced frame during the handshake; a resume needs one")
	}

	// Drop the actor. Reading b's offline presence is the barrier: it proves
	// the disconnect broadcast has been sequenced before b posts, so the two
	// replayed events always land in the same order.
	b.record = true
	if err := a.conn.Close(websocket.StatusNormalClosure, "resume"); err != nil {
		t.Fatalf("closing conn \"a\": %v", err)
	}
	b.expect("presence")

	b.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-resume-1",
		"payload": map[string]any{"channel_id": textChannelID, "content": "sent while away"},
	})
	b.expect("chat_send_ok")
	b.expect("chat_message")
	// b's barrier closes ITS recorded list here rather than at the end of the
	// journey — the second of the file header's two barrier exceptions.
	// Everything b has to say about the away window is said, and the only frame
	// the server can still send it is alice's back-online presence from the
	// resume below, whose shape is already recorded on a2 as the last frame of
	// the replay burst. Moving the barrier past the resume is NOT the fix it
	// looks like: b's ping would then race the tail of the hub's fan-out loop
	// for that presence, and pong could win — a flake that -race and -tags
	// deadlock surface on a loaded runner, in a file whose whole job is to fail
	// only for real drift.
	b.barrier()
	b.record = false

	a2 := r.dial(t, "a")
	a2.record = true
	a2.send(map[string]any{
		"type": "auth",
		"id":   "req-auth-resume",
		"payload": map[string]any{
			"token":             aliceTok,
			"last_seq":          lastSeq,
			"active_channel_id": textChannelID,
		},
	})
	authOK := a2.expect("auth_ok")
	payload, _ := authOK["payload"].(map[string]any)
	if src := payload["replay_source"]; src != "buffer" {
		t.Fatalf("resume served from %q, want \"buffer\" — the replay tier under test", src)
	}
	a2.expect("presence")     // replayed: the actor's own disconnect
	a2.expect("chat_message") // replayed: what it missed
	a2.expect("presence")     // live: back online
	a2.barrier()
}

// journeyVoiceJoinE2EELeave records a two-party encrypted call: both join, the
// key holder (lowest connected user id in the room) announces its ECDH public
// key and offers the room key to its peer, then leaves.
//
// The fixture carries both forms of voice_state: the sequenced broadcast a
// room's audience receives, and the unsequenced copy the joiner is handed for
// each participant already in the room. See expectJoinBurst for why a joiner's
// own voice_state is recorded on its peer's connection rather than its own.
func journeyVoiceJoinE2EELeave(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence")

	a.record, b.record = true, true

	// alice joins an empty room: token, then room config.
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	a.expectJoinBurst(aliceID, "voice_token", "voice_config")
	b.expect("voice_state") // alice's, broadcast to the room's audience

	// bob joins an occupied room: token, the state of every participant already
	// there, then room config. Reading his voice_config is also the barrier for
	// the announce below — the voice-topic subscription he needs to receive it
	// is made earlier in the same handler.
	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	b.expectJoinBurst(bobID, "voice_token", "voice_state", "voice_config")
	a.expect("voice_state") // bob's, broadcast to the room's audience

	// alice publishes her ECDH public key, signed by her identity key; the
	// server checks only the size and base64-ness of both and relays them
	// verbatim (voice_e2ee.go:126-140) — it never verifies the signature.
	a.send(map[string]any{
		"type": "voice_e2ee_announce",
		"payload": map[string]any{
			"public_key": "YWxpY2UtZWNkaC1wdWJsaWMta2V5LWZpeHR1cmU=",
			"signature":  "YWxpY2Utc2lnbmF0dXJlLW92ZXItaGVyLWVjZGgta2V5",
		},
	})
	b.expect("voice_e2ee_announce")

	// bob answers with a legacy announce and no signature at all. signature is
	// omitempty on both the command and the relay, so this is what freezes its
	// ABSENT form — alice's above froze the present one, and a field recorded
	// only one way would let the other be renamed or dropped unseen. The relay
	// excludes its sender and alice is idle, so it is the only frame in flight
	// on her socket.
	b.send(map[string]any{
		"type": "voice_e2ee_announce",
		"payload": map[string]any{
			"public_key": "Ym9iLWVjZGgtcHVibGljLWtleS1maXh0dXJl",
		},
	})
	a.expect("voice_e2ee_announce")

	// alice is the key holder (lowest user id in the room) and offers the room
	// key to bob.
	a.send(map[string]any{
		"type": "voice_e2ee_offer",
		"payload": map[string]any{
			"target_user_id": bobID,
			"encrypted_key":  "ZW5jcnlwdGVkLXJvb20ta2V5LWZpeHR1cmU=",
			"iv":             "aXYtZml4dHVyZS0xMg==",
		},
	})
	b.expect("voice_e2ee_offer")

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}
