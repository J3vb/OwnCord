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
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
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

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

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

// journeyFreshConnect records the whole handshake — auth, auth_ok, ready, and
// the member_join + presence_batch a first-ever connect broadcasts (which the
// connecting client receives too) — TWICE, once per kind of account.
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
	a.expect("presence_batch")

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
	b.expect("presence_batch")

	// bob's connect as an already-connected client sees it.
	a.expect("member_join")
	a.expect("presence_batch")

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
	a.drain("member_join", "presence_batch") // b's connect, observed by a
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
	a.drain("member_join", "presence_batch")
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
	a.drain("member_join", "presence_batch")
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
	a.drain("member_join", "presence_batch")
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

// journeyChannelActivity records the unread hint (WP 2B-2): bob is connected
// but has not focused the channel alice posts in, so he gets a channel_activity
// frame and no chat_message. The hint is delivered by a worker on a 1 s
// window and rides the low queue, which a pong may overtake, so the journey
// flushes the window itself before bob's barrier and reads the frame first.
// alice's barrier proves her chat_send finished emitting before that flush.
func journeyChannelActivity(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")
	a.focus(textChannelID, false)

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-channel-activity-1",
		"payload": map[string]any{"channel_id": textChannelID, "content": "hello unfocused"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	a.barrier()
	r.hub.FlushChannelActivityNowForTest()
	b.expect("channel_activity")
	b.barrier()
}

// journeyMarkRead records mark_read, which answers with one read_state frame
// to the caller (WP 3D-5c) and nothing else.
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
	a.expect("read_state")
	a.barrier()
}

// journeyMarkUnread records mark_unread: the pointer moves to the message
// before the one named and the caller gets a read_state frame.
func journeyMarkUnread(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, _ := r.seedBaseline(t)
	if _, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "first", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	second, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "second", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	a := r.dial(t, "a")
	a.authenticate(aliceTok)

	a.record = true
	a.send(map[string]any{
		"type":    "mark_unread",
		"payload": map[string]any{"channel_id": textChannelID, "message_id": second},
	})
	a.expect("read_state")
	a.barrier()
}

// journeyDMSend records a direct message. DM traffic is addressed to the
// participant ids rather than a channel topic, so neither side needs focus,
// and the whole fan-out is synchronous on the sender's connection.
//
// B5-6 gate note: GetOrCreateDMChannel below runs at the DB layer, below
// service.MessageService's first-contact gate, and this pair has no
// trusted_senders row at journey start (migration 046's grandfathering
// backfill runs once at migration time over pairs that already exist then —
// this journey's pair does not exist yet). Without the explicit TrustSender
// call, alice's send below would be gated exactly like a stranger's first
// message: bob would get a dm_request instead of chat_message, and this
// fixture would silently start recording a different journey. Trusting the
// pair here keeps the recorded frames byte-identical to before B5-6 — see
// the spec's own warning that a green dm-send.json never proved anything
// about the gate.
func journeyDMSend(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if err := r.db.TrustSender(context.Background(), bobID, aliceID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

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

// journeyDMRequest records alice, a stranger to bob, sending the first
// message of a fresh one-to-one DM (B5-6): alice's side is byte-identical to
// journeyDMSend (chat_send_ok, chat_message — decision 5), and bob, who does
// not yet trust alice, gets exactly one dm_request instead of the message
// itself.
func journeyDMRequest(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-dm-request-1",
		"payload": map[string]any{"channel_id": dmChannel.ID, "content": "hi, stranger"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	b.expect("dm_request")
	a.barrier()
	b.barrier()
}

// journeyDMRequestIgnored records a resend after the recipient ignored the
// first request (decision 5's silence property, and the "resend creates
// nothing" rule): bob ignores alice's first message (drained, not part of
// this journey — the request gate itself is service/message_request_test.go's
// job), then alice sends again. Alice's side records the same two frame
// types as any other send; bob records nothing at all — no second
// dm_request, no chat_message.
func journeyDMRequestIgnored(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	// Setup, not recorded: alice's first message stages the request and bob
	// drains the resulting dm_request, then the request is marked ignored
	// directly — there is no REST/WS decision route wired into this harness;
	// the transition itself is service/message_request_test.go's and
	// api/dm_request_handler_test.go's job.
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-dm-request-ignored-setup",
		"payload": map[string]any{"channel_id": dmChannel.ID, "content": "hi, stranger"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	b.drain("dm_request")

	ctx := context.Background()
	if _, err := r.db.ExecContext(ctx,
		`UPDATE message_requests SET state = 'ignored', decided_at = datetime('now') WHERE sender_id = ? AND recipient_id = ?`,
		aliceID, bobID); err != nil {
		t.Fatalf("marking the request ignored: %v", err)
	}

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-dm-request-ignored-1",
		"payload": map[string]any{"channel_id": dmChannel.ID, "content": "hello again"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
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
	a.drain("member_join", "presence_batch")
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
	b.expect("presence_batch")

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
	a2.expect("presence_batch") // replayed: the actor's own disconnect
	a2.expect("chat_message")   // replayed: what it missed
	a2.expect("presence_batch") // live: back online
	a2.barrier()
}

// journeyVoiceJoinE2EELeave records a two-party encrypted call: both join, the
// key holder (lowest connected user id in the room) announces its ECDH public
// key and offers the room key to its peer, then leaves.
//
// The fixture carries both forms of voice_state: the sequenced broadcast a
// room's audience receives (sent synchronously to the joiner too, OC-0349 —
// its position in the join burst is now part of the contract), and the
// unsequenced copy the joiner is handed directly for each participant
// already in the room.
func journeyVoiceJoinE2EELeave(t *testing.T, r *epochRig) {
	_, bobID, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true

	// alice joins an empty room: token, her own state, then room config.
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	a.expect("voice_token")
	a.expect("voice_state") // alice's own, sent synchronously (OC-0349)
	a.expect("voice_config")
	b.expect("voice_state") // alice's, broadcast to the room's audience

	// bob joins an occupied room: token, his own state, the state of every
	// participant already there, then room config. Reading his voice_config is
	// also the barrier for the announce below — the voice-topic subscription
	// he needs to receive it is made earlier in the same handler.
	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	b.expect("voice_token")
	b.expect("voice_state") // bob's own, sent synchronously (OC-0349)
	b.expect("voice_state") // alice's, relayed to the joiner
	b.expect("voice_config")
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

// journeyVoiceWatch records who-watches-what: two members share a room, alice
// reports that she watches bob's screen share (voice_watch), bob receives the
// unsequenced voice_watching relay, then bob clears his own (empty) set and
// alice receives that. The sender never gets its own frame.
func journeyVoiceWatch(t *testing.T, r *epochRig) {
	_, bobID, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true

	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	a.expect("voice_token")
	a.expect("voice_state")
	a.expect("voice_config")
	b.expect("voice_state")

	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	b.expect("voice_token")
	b.expect("voice_state")
	b.expect("voice_state")
	b.expect("voice_config")
	a.expect("voice_state")

	// Duplicates and alice's own id (1) are dropped; the relay is sorted.
	a.send(map[string]any{
		"type":    "voice_watch",
		"payload": map[string]any{"user_ids": []any{bobID, bobID, 1}},
	})
	b.expect("voice_watching")

	b.send(map[string]any{
		"type":    "voice_watch",
		"payload": map[string]any{"user_ids": []any{}},
	})
	a.expect("voice_watching")

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// ─── voice and call slice (WP 7.3a) ──────────────────────────────────────────

// voiceJoinPair joins alice ("a") then bob ("b") to channel id, recording both
// join bursts exactly as journeyVoiceWatch does: alice's own token, state and
// room config plus bob's broadcast on her side, then bob's token, own state,
// the relayed state of alice and config, with alice's copy of bob's state. Each
// read is per connection, so the interleaving between the two sockets is never
// part of the contract.
func voiceJoinPair(a, b *wsConn, channelID int64) {
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID},
	})
	a.expect("voice_token")
	a.expect("voice_state")
	a.expect("voice_config")
	b.expect("voice_state")

	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID},
	})
	b.expect("voice_token")
	b.expect("voice_state")
	b.expect("voice_state")
	b.expect("voice_config")
	a.expect("voice_state")
}

// journeyVoiceSelfState records the four self-service state toggles, each on
// and then off, as the voice_state broadcast every one of them produces. The
// sender receives its own copy (synchronously, as on join) and the room's other
// member receives the broadcast. Every toggle is sent exactly twice: the
// per-user limit is two per second per command, so a third would be dropped
// with a rate_limited error instead of a frame.
func journeyVoiceSelfState(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	voiceJoinPair(a, b, voiceChannelID)

	toggles := []struct {
		msgType, key string
	}{
		{"voice_mute", "muted"},
		{"voice_deafen", "deafened"},
		{"voice_camera", "enabled"},
		{"voice_screenshare", "enabled"},
	}
	for _, tg := range toggles {
		for _, on := range []bool{true, false} {
			a.send(map[string]any{"type": tg.msgType, "payload": map[string]any{tg.key: on}})
			a.expect("voice_state")
			b.expect("voice_state")
		}
	}

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// seedModerator promotes alice to the Admin role (id 2, position 80, carries
// MUTE_MEMBERS; the migration-001 Moderator role (id 3) does not; Member
// is lower) so her voice_mod_* commands clear the hierarchy and
// MUTE_MEMBERS gate. It runs before any connection is dialled, so the promoted
// role is what the permission cache first loads.
func (r *epochRig) seedModerator(t *testing.T, aliceID int64) {
	t.Helper()
	if err := r.db.UpdateUserRole(context.Background(), aliceID, 2); err != nil {
		t.Fatalf("UpdateUserRole(alice, admin): %v", err)
	}
}

// seedSecondVoiceChannel adds the destination a voice_mod_move needs. It lives
// here, not in seedBaseline, so no other fixture's channel list changes.
func (r *epochRig) seedSecondVoiceChannel(t *testing.T) int64 {
	t.Helper()
	id, err := r.db.CreateChannel(context.Background(), "Voice 2", "voice", "", "", 2)
	if err != nil {
		t.Fatalf("CreateChannel(Voice 2): %v", err)
	}
	if id != secondVoiceChannelID {
		t.Fatalf("second voice channel id = %d, want %d — the fixtures record channel_id verbatim", id, secondVoiceChannelID)
	}
	return id
}

const secondVoiceChannelID = 3

// journeyVoiceModeration records alice, promoted to Admin, server-muting
// and server-deafening bob (on, then off) while both sit in one voice room.
// Each action is one voice_state broadcast, reaching both sockets. A server
// deafen implies a server mute, so the deafen frames carry both flags.
func journeyVoiceModeration(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	voiceJoinPair(a, b, voiceChannelID)

	for _, on := range []bool{true, false} {
		a.send(map[string]any{
			"type":    "voice_mod_mute",
			"payload": map[string]any{"channel_id": voiceChannelID, "user_id": bobID, "muted": on},
		})
		a.expect("voice_state")
		b.expect("voice_state")
	}
	for _, on := range []bool{true, false} {
		a.send(map[string]any{
			"type":    "voice_mod_deafen",
			"payload": map[string]any{"channel_id": voiceChannelID, "user_id": bobID, "deafened": on},
		})
		a.expect("voice_state")
		b.expect("voice_state")
	}

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// journeyVoiceModerationMoveKick records alice, promoted to Admin, moving bob
// to a second voice channel and then disconnecting him from it.
//
// A move is a server-driven leave followed by voice_moved; the re-join is the
// target's own voice_join, which bob sends here so the kick has somebody to
// act on. Ordering subtleties, all per connection: bob's voice_leave (the
// eviction's broadcast, which reaches him through the hub's fan-out loop) and
// voice_moved (a direct send from the handler) race each other, so they are
// read with expectEither and recorded direct-send first. Voice broadcasts reach
// every client that can see the channel, so alice sees bob's leave from the
// first room, his state in the destination and his leave from it. Bob
// rejoins the DESTINATION, which the post-move rejoin block does not cover (it
// holds only for the channel he was moved out of). After the kick the same
// pairing holds and is recorded the same way: voice_disconnected, then
// voice_leave. Only bob gets voice_disconnected.
func journeyVoiceModerationMoveKick(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	// Only MOVE_MEMBERS opens a move; the seeded Admin role lacks it.
	if _, err := r.db.ExecContext(context.Background(),
		`UPDATE roles SET permissions = permissions | ? WHERE id = 2`, permissions.MoveMembers); err != nil {
		t.Fatalf("grant MOVE_MEMBERS to admin: %v", err)
	}
	r.seedSecondVoiceChannel(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	voiceJoinPair(a, b, voiceChannelID)

	a.send(map[string]any{
		"type":    "voice_mod_move",
		"payload": map[string]any{"user_id": bobID, "to_channel_id": secondVoiceChannelID},
	})
	b.expectEither("voice_moved", "voice_leave")
	a.expect("voice_leave")

	b.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": secondVoiceChannelID},
	})
	b.expect("voice_token")
	b.expect("voice_state")
	b.expect("voice_config")
	a.expect("voice_state") // bob's, in the destination room: broadcast reaches her too

	a.send(map[string]any{
		"type":    "voice_mod_kick",
		"payload": map[string]any{"user_id": bobID},
	})
	b.expectEither("voice_disconnected", "voice_leave")
	a.expect("voice_leave") // bob's, from the destination room

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave") // alice's, from the first room; bob is out of voice but still sees it
	a.barrier()
	b.barrier()
}

// journeyVoiceTokenRefresh records a member asking for a fresh LiveKit token
// while in a room: the reply is a voice_token addressed to her alone, shaped
// exactly like the one from voice_join. The server allows one refresh per user
// per minute, so this is the only one the journey sends. Nobody else gets a
// frame, which the closing barrier on bob proves.
func journeyVoiceTokenRefresh(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": voiceChannelID},
	})
	a.expect("voice_token")
	a.expect("voice_state")
	a.expect("voice_config")
	b.expect("voice_state")

	a.send(map[string]any{"type": "voice_token_refresh", "payload": map[string]any{}})
	a.expect("voice_token")

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// journeyCallRingDecline records a one-to-one DM call that is rung and
// declined. alice joins the DM's voice channel first (a ring from someone who
// is not in the call is refused), rings, and bob — who is not in the call —
// receives call_incoming and declines; alice receives call_declined. The call
// signals are direct per-user sends to the other participant only: the ringer
// gets nothing back for the ring and the decliner nothing for the decline.
// Ring and decline are separate rate-limit keys (one per three seconds each),
// so one of each fits.
//
// alice's join broadcasts voice_state to bob too (voice broadcasts reach every
// client that can see the channel, and a DM is visible to both members), so it
// is part of bob's list. The DM exists before either connects and each member
// trusts the other (the ring is filtered on the callee trusting the caller, the
// decline on the reverse), so no dm_request or dm_channel_open frame appears.
func journeyCallRingDecline(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if err := r.db.TrustSender(context.Background(), bobID, aliceID, "accepted"); err != nil {
		t.Fatalf("TrustSender(bob trusts alice): %v", err)
	}
	// The decline fans out under the same trust filter as the ring, in the
	// other direction: without alice trusting bob the call_declined would be
	// silently dropped.
	if err := r.db.TrustSender(context.Background(), aliceID, bobID, "accepted"); err != nil {
		t.Fatalf("TrustSender(alice trusts bob): %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": dmChannel.ID},
	})
	a.expect("voice_token")
	a.expect("voice_state")
	a.expect("voice_config")
	b.expect("voice_state")

	a.send(map[string]any{"type": "call_ring", "payload": map[string]any{"channel_id": dmChannel.ID}})
	b.expect("call_incoming")

	b.send(map[string]any{"type": "call_decline", "payload": map[string]any{"channel_id": dmChannel.ID}})
	a.expect("call_declined")

	a.send(map[string]any{"type": "voice_leave", "payload": map[string]any{}})
	a.expect("voice_leave")
	b.expect("voice_leave")
	a.barrier()
	b.barrier()
}

// journeyVoiceModDenied records the server answering a voice command with
// `error`: bob, a plain member, tries to disconnect alice, who is his equal in
// rank. The hierarchy check runs before anything else about the target, so the
// refusal is the same whether or not alice is in voice and nothing is
// broadcast. The error is a direct reply carrying the request's code and
// message; neither the actor nor the target receives any other frame.
func journeyVoiceModDenied(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	b.send(map[string]any{
		"type":    "voice_mod_kick",
		"payload": map[string]any{"user_id": aliceID},
	})
	b.expect("error")
	a.barrier()
	b.barrier()
}

// ─── WP 7.3b: channel, chat and admin frames ─────────────────────────────────
//
// Most of these frames have no websocket command that produces them: the REST
// or service layer decides, and the hub only fans out. The journeys therefore
// trigger them the way production does where the harness can (the DM and NSFW
// routes are mounted over the rig's hub; the moderation and appeal services are
// wired to it as api/router.go wires them) and otherwise call the exported hub
// method the admin/service layer calls. Each journey says which.
//
// Targeted, unsequenced frames (mention_count, mod_queue, mod_action,
// appeal_status, presence) travel on the LOW-priority queue, which pong may
// overtake — so those journeys read the low frame BEFORE their barrier is
// sent, never after: nothing is pending on the low queue when ping goes out.

// restRig is the rig's REST surface: the DM and NSFW routes, authenticated by
// the same session tokens the websockets use, with the hub as broadcaster.
type restRig struct {
	url string
}

func (r *epochRig) mountREST(t *testing.T) *restRig {
	t.Helper()
	router := chi.NewRouter()
	api.MountDMRoutes(router, r.svc, r.hub, nil, nil)
	api.MountNSFWRoutes(router, r.svc, r.hub)
	api.MountProfileRoutes(router, r.svc, nil, auth.NewRateLimiter(), nil, r.hub, nil)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return &restRig{url: srv.URL}
}

// do sends one authenticated REST request and fails the test on any status
// other than want.
func (rr *restRig) do(t *testing.T, method, path, token string, body any, want int) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshalling %s %s body: %v", method, path, err)
		}
		rdr = bytes.NewReader(raw)
	} else {
		rdr = bytes.NewReader(nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), frameDeadline)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, rr.url+path, rdr)
	if err != nil {
		t.Fatalf("building %s %s: %v", method, path, err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != want {
		t.Fatalf("%s %s = %d, want %d", method, path, resp.StatusCode, want)
	}
}

// fixtureClientMessageUUID is the random half of a client_message_id: the
// service wants "<13-digit unix ms>:<uuid v4>" stamped within the last day, so
// the first half is taken from the clock and the echoed id is normalised.
const fixtureClientMessageUUID = "6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"

// journeyChatForwardPin records a forward of an existing message into a DM and
// the pin/unpin broadcast for that message.
//
// chat_forward answers like chat_send: the sender's direct chat_forward_ok,
// then the sequenced chat_message for the target (here the alice/bob DM, so bob
// receives it without focusing it). Bob trusts alice, so no dm_request
// replaces the message. chat_pinned is the hub fan-out the pin route calls
// (Hub.BroadcastMessagePinned), sequenced on the message's channel, so both
// focused sockets get it — once for pin, once for unpin. Each trigger is
// fully read on both sockets before the next, so no cross-trigger ordering is
// part of the fixture.
func journeyChatForwardPin(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	ctx := context.Background()
	msgID, err := r.db.CreateMessage(ctx, textChannelID, aliceID, "message to forward", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	dmChannel, _, err := r.db.GetOrCreateDMChannel(ctx, aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if err := r.db.TrustSender(ctx, bobID, aliceID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")
	a.focus(textChannelID, false)
	b.focus(textChannelID, true)

	a.record, b.record = true, true
	a.send(map[string]any{
		"type": "chat_forward",
		"id":   "req-chat-forward-1",
		"payload": map[string]any{
			"channel_id":        dmChannel.ID,
			"message_id":        msgID,
			"client_message_id": fmt.Sprintf("%d:%s", time.Now().UnixMilli(), fixtureClientMessageUUID),
		},
	})
	a.expect("chat_forward_ok")
	a.expect("chat_message")
	b.expect("chat_message")

	for _, pinned := range []bool{true, false} {
		r.hub.BroadcastMessagePinned(textChannelID, msgID, pinned)
		a.expect("chat_pinned")
		b.expect("chat_pinned")
	}
	a.barrier()
	b.barrier()
}

// journeyChatPoll records a poll's life: a creates it, b votes, removes the
// vote and votes again, and a ends it. Every vote and the end reach both
// focused sockets as a sequenced poll_update with the full counts and the
// version, and the voter alone gets poll_vote_ok.
func journeyChatPoll(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)
	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")
	a.focus(textChannelID, false)
	b.focus(textChannelID, true)

	a.record, b.record = true, true
	a.send(map[string]any{
		"type": "poll_create",
		"id":   "req-poll-create-1",
		"payload": map[string]any{
			"client_message_id": fmt.Sprintf("%d:%s", time.Now().UnixMilli(), fixtureClientMessageUUID),
			"channel_id":        textChannelID,
			"question":          "Lunch?",
			"answers":           []map[string]any{{"text": "Pizza", "emoji": "🍕"}, {"text": "Sushi"}},
			"duration_hours":    24,
			"allow_multiselect": false,
		},
	})
	created := a.expect("poll_create_ok")
	a.expect("chat_message")
	b.expect("chat_message")
	pollID, err := created["payload"].(map[string]any)["message_id"].(json.Number).Int64()
	if err != nil {
		t.Fatalf("poll_create_ok message_id: %v", err)
	}

	for i, ids := range [][]int{{1}, {}, {2}} {
		b.send(map[string]any{
			"type":    "poll_vote",
			"id":      fmt.Sprintf("req-poll-vote-%d", i+1),
			"payload": map[string]any{"message_id": pollID, "answer_ids": ids},
		})
		b.expect("poll_vote_ok")
		a.expect("poll_update")
		b.expect("poll_update")
	}
	a.send(map[string]any{"type": "poll_end", "id": "req-poll-end-1", "payload": map[string]any{"message_id": pollID}})
	a.expect("poll_end_ok")
	a.expect("poll_update")
	b.expect("poll_update")
	a.barrier()
	b.barrier()
}

// journeyChatForumPost records a forum post's creation: a declares the forums
// feature and posts to a forum with one tag. The creator gets forum_post_create_ok
// carrying the thread, its post block and the opening message; nothing is
// broadcast to a connection that is not subscribed to the new thread or the
// forum, so the transcript ends with the barrier. The post makes a a follower,
// and the coalescer's leading flush tells it so with a thread_follow_update on
// the low queue. That frame races the barrier's pong, so it is read, checked
// and left out of the transcript before the barrier is sent.
func journeyChatForumPost(t *testing.T, r *epochRig) {
	_, _, aliceTok, _ := r.seedBaseline(t)
	ctx := context.Background()
	forumID, err := r.db.CreateChannel(ctx, "ideas", "forum", "", "", 2)
	if err != nil {
		t.Fatalf("CreateChannel(ideas): %v", err)
	}
	tags, err := r.db.ReplaceForumSettings(ctx, forumID, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 1440, Tags: []db.ForumTagWrite{{Name: "idea"}},
	})
	if err != nil {
		t.Fatalf("ReplaceForumSettings: %v", err)
	}
	a := r.dial(t, "a")
	a.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-a",
		"payload": map[string]any{"token": aliceTok, "last_seq": 0, "features": []string{"forums"}},
	})
	a.drain("auth_ok", "ready", "member_join", "presence_batch")

	a.record = true
	a.send(map[string]any{
		"type": "forum_post_create",
		"id":   "req-forum-post-1",
		"payload": map[string]any{
			"client_message_id": fmt.Sprintf("%d:%s", time.Now().UnixMilli(), fixtureClientMessageUUID),
			"channel_id":        forumID,
			"name":              "Dark mode",
			"content":           "Please add a dark theme.",
			"tag_ids":           []int64{tags[0].ID},
		},
	})
	a.expect("forum_post_create_ok")
	if got := a.readRaw()["type"]; got != "thread_follow_update" {
		t.Fatalf("conn %q: expected the creator's thread_follow_update, got %q", a.name, got)
	}
	a.barrier()
}

// journeyChatBulkDelete records the single chat_bulk_deleted a purge sends in
// place of N chat_deleted frames (Hub.BroadcastChatBulkDeleted, which the
// retention and erasure paths call). It is sequenced on the channel, so both
// focused sockets receive it. Its ids array is NOT normalised (the key is
// "ids", not "*_id"); the values are the first three message ids of a freshly
// migrated database, so they are deterministic.
func journeyChatBulkDelete(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	ids := make([]int64, 0, 3)
	for _, text := range []string{"one", "two", "three"} {
		id, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, text, nil)
		if err != nil {
			t.Fatalf("CreateMessage(%s): %v", text, err)
		}
		ids = append(ids, id)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")
	// Both sockets wait for their subscription: nothing a sends afterwards
	// orders the hub's broadcast behind a's focus (unlike chat-forward-pin,
	// where a's own chat_forward does), so an unconfirmed focus is a flake.
	// Two pings for a within a second is the per-user ceiling (see barrier).
	a.focus(textChannelID, true)
	b.focus(textChannelID, true)

	a.record, b.record = true, true
	r.hub.BroadcastChatBulkDeleted(textChannelID, ids)
	a.expect("chat_bulk_deleted")
	b.expect("chat_bulk_deleted")
	a.barrier()
	b.barrier()
}

// nsfwChannelID is the labelled channel mention-count-nsfw-ack seeds; the
// baseline holds channels 1 and 2.
const nsfwChannelID = 3

// journeyMentionCountNSFWAck records two targeted, unsequenced frames to bob.
//
// mention_count is what the mention service sends when it bumps a reader's
// total (Hub.NotifyMentionCount); it is only delivered to a reader who can see
// the channel. nsfw_ack is what the acknowledge route sends to the caller's
// live sockets, and the revoke route sends the same frame with
// acknowledged:false — driven here through the real REST handlers over the
// rig's hub, so the frame's shape is the handler's own. alice is connected but
// idle: neither frame is hers, so her only recorded frames are the barrier.
// Both are low-priority, read before the barrier (see the section comment).
func journeyMentionCountNSFWAck(t *testing.T, r *epochRig) {
	_, bobID, aliceTok, bobTok := r.seedBaseline(t)
	ctx := context.Background()
	id, err := r.db.CreateChannel(ctx, "adults", "text", "", "", 3)
	if err != nil {
		t.Fatalf("CreateChannel(adults): %v", err)
	}
	if id != nsfwChannelID {
		t.Fatalf("nsfw channel id = %d, want %d", id, nsfwChannelID)
	}
	if err := r.db.AdminUpdateChannel(ctx, id, db.ChannelUpdate{Name: "adults", Position: 3, NSFW: true}); err != nil {
		t.Fatalf("AdminUpdateChannel(nsfw): %v", err)
	}
	rest := r.mountREST(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	r.hub.NotifyMentionCount(bobID, textChannelID, 2)
	b.expect("mention_count")

	nsfwPath := "/api/v1/channels/3/nsfw-acknowledgement"
	rest.do(t, http.MethodPut, nsfwPath, bobTok, nil, http.StatusNoContent)
	b.expect("nsfw_ack")
	rest.do(t, http.MethodDelete, nsfwPath, bobTok, nil, http.StatusNoContent)
	b.expect("nsfw_ack")
	a.barrier()
	b.barrier()
}

// journeyChatCommandUnknown records a slash command nothing owns: the hub in
// this rig has no plugin registry, so the dispatcher answers with an error
// rather than a command_reply. This is the only chat_command outcome that does
// not depend on the build tag — with the wazero runtime absent a registered
// plugin answers with a reply naming the missing runtime, and a reply or
// plugin_broadcast needs a compiled guest module — so command_reply and
// plugin_broadcast are NOT frozen here (see the WP 7.3b report).
func journeyChatCommandUnknown(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	a.send(map[string]any{
		"type": "chat_command",
		"id":   "req-chat-command-1",
		"payload": map[string]any{
			"channel_id": textChannelID,
			"command":    "/nosuchcommand",
			"args":       []string{"one", "two"},
		},
	})
	a.expect("error")
	a.barrier()
	b.barrier()
}

// journeyChannelCRUD records the three channel frames an admin edit produces,
// for a channel the baseline does not have. The database change is made first
// and then the hub method the admin handler calls
// (BroadcastChannelCreate/Update/Delete) — the REST admin routes are not part
// of this harness. channel_create is sent to each reader with that reader's
// own affordance verdicts (can_send ... can_react), so alice and bob carry
// their own copies; channel_update is one sequenced broadcast; channel_delete
// is the bare id. Every trigger is read on both sockets before the next.
func journeyChannelCRUD(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)
	ctx := context.Background()

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	id, err := r.db.CreateChannel(ctx, "announcements", "text", "Info", "fixture topic", 3)
	if err != nil {
		t.Fatalf("CreateChannel(announcements): %v", err)
	}
	ch, err := r.db.GetChannel(ctx, id)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}

	a.record, b.record = true, true
	r.hub.BroadcastChannelCreate(ch)
	a.expect("channel_create")
	b.expect("channel_create")

	if err := r.db.AdminUpdateChannel(ctx, id, db.ChannelUpdate{
		Name: "news", Topic: "edited topic", CategoryID: ch.CategoryID, SlowMode: 10, Position: 3, VoiceMaxVideo: 25,
	}); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}
	if ch, err = r.db.GetChannel(ctx, id); err != nil {
		t.Fatalf("GetChannel(updated): %v", err)
	}
	r.hub.BroadcastChannelUpdate(ch)
	a.expect("channel_update")
	b.expect("channel_update")

	if err := r.db.AdminDeleteChannel(ctx, id); err != nil {
		t.Fatalf("AdminDeleteChannel: %v", err)
	}
	r.hub.BroadcastChannelDelete(id)
	a.expect("channel_delete")
	b.expect("channel_delete")
	a.barrier()
	b.barrier()
}

// journeyDMOpenClose records a DM appearing in the recipient's sidebar and
// disappearing from the closer's, through the real REST handlers over the
// rig's hub. alice creates the DM with bob, who already trusts her, so bob
// (and only bob) gets dm_channel_open — the creator learns from the REST
// response. alice then closes it, which sends dm_channel_close to her alone.
// Both frames are targeted and unsequenced.
func journeyDMOpenClose(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	if err := r.db.TrustSender(context.Background(), bobID, aliceID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	rest := r.mountREST(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	rest.do(t, http.MethodPost, "/api/v1/dms", aliceTok, map[string]any{"recipient_id": bobID}, http.StatusCreated)
	b.expect("dm_channel_open")

	rest.do(t, http.MethodDelete, "/api/v1/dms/3", aliceTok, nil, http.StatusNoContent)
	a.expect("dm_channel_close")
	a.barrier()
	b.barrier()
}

// configureUploadFileTypes gives the hub the settings-backed upload policy
// source Hub.BroadcastUploadPolicy needs; without one the broadcast is a no-op.
func configureUploadFileTypes(opts *ws.HubOptions) {
	opts.UploadFileTypes = fixtureFileTypes{}
}

type fixtureFileTypes struct{}

func (fixtureFileTypes) FileTypePolicy(context.Context) (storage.FileTypePolicy, error) {
	return storage.FileTypePolicy{Blocked: []string{"bat", "exe"}, Allowed: []string{}}, nil
}

// journeyServerAdminBroadcasts records the server-wide frames, each reaching
// both sockets: emoji_update (the full custom-emoji set, Hub.BroadcastEmojiUpdate
// as the emoji handlers call it), upload_policy (both lists, always arrays;
// unsequenced), server_restart (the update announcement; the redial spread
// scales with the two connected clients) and presence — alice's own
// presence_update answered by the broadcast of her new status to everyone,
// herself included. presence is the low-priority frame the file header warns
// about: it is read on both sockets before the barrier's ping is sent, so the
// pong has nothing to overtake.
func journeyServerAdminBroadcasts(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	emoji, err := r.db.CreateEmoji(context.Background(), "fixture", "fixture.png", "image/png", aliceID)
	if err != nil {
		t.Fatalf("CreateEmoji: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	r.hub.BroadcastEmojiUpdate([]*db.Emoji{emoji})
	a.expect("emoji_update")
	b.expect("emoji_update")

	r.hub.BroadcastUploadPolicy()
	a.expect("upload_policy")
	b.expect("upload_policy")

	r.hub.BroadcastServerRestart(ws.RestartReasonUpdate, 30)
	a.expect("server_restart")
	b.expect("server_restart")

	a.send(map[string]any{"type": "presence_update", "payload": map[string]any{"status": "idle"}})
	a.expect("presence")
	b.expect("presence")
	a.barrier()
	b.barrier()
}

// journeyModerationQueue records the moderation fan-out for one report and one
// appeal. alice is promoted to Admin (a moderation-bit holder, so she is in the
// queue audience); bob is the reporter and the appellant, so he is excluded
// from the queue frames about his own report and appeal. carol is the reported
// user and never connects.
//
//   - mod_queue (report form): what the report route calls after filing
//     (Hub.BroadcastModQueue). Only alice receives it.
//   - mod_action: alice warns bob through the real moderation service, wired to
//     the hub as api/router.go wires it. Only bob receives it; expires_at is
//     null for a warning (the timeout form also emits member_timeouts and a
//     channel refresh, which belong to the role/permission fan-out frames and
//     are not frozen here).
//   - mod_queue (appeal form) and appeal_status: bob appeals the warning and
//     alice assigns and decides it, through the real appeal service. The appeal
//     queue frames go to alice, the status frames to bob; each step is read
//     before the next so no cross-connection order is part of the fixture.
//
// All four frames are low-priority and unsequenced, read before the barrier.
func journeyModerationQueue(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	carolID, _ := r.seedUser(t, "carol")
	ctx := context.Background()
	r.svc.Moderation.SetNotifier(r.hub)
	r.svc.Appeals.SetNotifier(r.hub)
	r.svc.Appeals.SetQueueBroadcaster(r.hub)

	reportID, err := r.db.FileReport(ctx, "fixture-report", bobID, carolID, "user", "1", nil, "spam", "", nil)
	if err != nil {
		t.Fatalf("FileReport: %v", err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	r.hub.BroadcastModQueue(ctx, reportID, "open")
	a.expect("mod_queue")

	actionID, err := r.svc.Moderation.Warn(ctx, aliceID, bobID, "fixture warning", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}
	b.expect("mod_action")

	appealID, err := r.svc.Appeals.Submit(ctx, bobID, actionID, "please reconsider")
	if err != nil {
		t.Fatalf("Appeals.Submit: %v", err)
	}
	a.expect("mod_queue")

	if err := r.svc.Appeals.Assign(ctx, aliceID, appealID, false); err != nil {
		t.Fatalf("Appeals.Assign: %v", err)
	}
	a.expect("mod_queue")
	b.expect("appeal_status")

	if err := r.svc.Appeals.Decide(ctx, aliceID, appealID, "overturned", "fixture decision"); err != nil {
		t.Fatalf("Appeals.Decide: %v", err)
	}
	a.expect("mod_queue")
	b.expect("appeal_status")
	a.barrier()
	b.barrier()
}

// ─── member and role frames (WP 7.3c) ───────────────────────────────────────
//
// These journeys drive the real services, then do exactly what the admin
// handlers do after the service call (the helpers below). Keeping that
// hand-off in three helpers means a later move of the fan-out into the
// services (WP 5.1a) changes one place, not five journeys.
//
// After WP 4.4b a role change is ONE Hub.EnqueueRoleRefresh and a hub worker
// settles it. Per affected socket the round is: the sidebar (channel_create
// per visible channel, with that user's affordances), the timeout view
// (member_timeouts), a paced member_update, and roles_update at the end of the
// round. The sidebar and the timeout view are written straight to the
// socket's queue by the worker; member_update and roles_update go through the
// hub's single dispatch loop, which the worker feeds in that order. So on one
// socket the order is fixed by construction and needs no tolerance; each
// trigger below is read on every socket before the next is fired, so nothing
// ties two triggers' frames together.

// roleIDModerator is migration 001's Moderator role (see seedModerator).
const (
	roleIDModerator = 3
	roleIDMember    = 4
)

// applyRoleChange is patchUserApplyRole (admin/handlers_users.go): the service
// call, then the release of the target's held topics and one role refresh.
func (r *epochRig) applyRoleChange(t *testing.T, actorID, targetID, roleID int64) {
	t.Helper()
	if _, err := r.svc.Moderation.ChangeUserRole(context.Background(), actorID, targetID, roleID); err != nil {
		t.Fatalf("ChangeUserRole(%d -> role %d): %v", targetID, roleID, err)
	}
	r.hub.RevokeUnreadableChannels(targetID)
	r.hub.EnqueueRoleRefresh(ws.RoleRefresh{Visibility: []int64{targetID}, MemberUpdate: []int64{targetID}})
}

// applyRoleEdit is handlePatchRole (admin/handlers_roles.go): the service
// call, the holders' cache eviction, and one refresh shaped by what changed.
func (r *epochRig) applyRoleEdit(t *testing.T, actorID, roleID int64, in service.RoleInput) {
	t.Helper()
	ctx := context.Background()
	holders, ok := r.svc.Roles.AffectedUserIDs(ctx, roleID)
	if !ok {
		t.Fatalf("AffectedUserIDs(%d) failed", roleID)
	}
	_, res, err := r.svc.Roles.UpdateRole(ctx, actorID, roleID, in)
	if err != nil {
		t.Fatalf("UpdateRole(%d): %v", roleID, err)
	}
	for _, uid := range holders {
		r.svc.Permissions.InvalidateUser(uid)
	}
	fan := ws.RoleRefresh{Roles: true}
	if res.Renamed {
		fan.MemberUpdate = holders
	}
	if res.PermsChanged {
		fan.Visibility = holders
	}
	r.hub.EnqueueRoleRefresh(fan)
}

// applyBan is patchUserApplyBan (admin/handlers_users.go) for a ban.
func (r *epochRig) applyBan(t *testing.T, actorID, targetID int64) {
	t.Helper()
	if err := r.svc.Moderation.BanUser(context.Background(), actorID, targetID, "fixture ban", nil); err != nil {
		t.Fatalf("BanUser(%d): %v", targetID, err)
	}
	r.hub.BroadcastMemberBan(targetID)
}

// journeyRoleChange records an admin promoting bob to Moderator and demoting
// him again. Each change gives bob (the target) a full refresh round and
// everyone else only the member_update:
//
//   - bob: channel_create for general and Voice (his affordances moved with his
//     role), member_timeouts (a moderator is sent the full list; on the demotion
//     the same frame replaces it with his own-only view), then member_update.
//   - alice: member_update only. roles_update is NOT part of a user's role
//     change (the role list did not move), so it is not recorded here; the
//     role-edit journey freezes it.
func journeyRoleChange(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	for _, roleID := range []int64{roleIDModerator, roleIDMember} {
		r.applyRoleChange(t, aliceID, bobID, roleID)
		b.expect("channel_create")
		b.expect("channel_create")
		b.expect("member_timeouts")
		b.expect("member_update")
		a.expect("member_update")
	}
	a.barrier()
	b.barrier()
}

// journeyRoleEdit records the two shapes of a role edit, both on the Member
// role bob holds and alice (Admin) does not:
//
//   - colour only: the cheap form, roles_update alone, to everyone.
//   - rename plus a permission change (SEND_MESSAGES removed): bob gets the
//     refreshed sidebar (can_send now false), then member_update for the new
//     role name, then roles_update closing the round. alice, not a holder, gets
//     member_update (it goes to everyone) and roles_update, but no sidebar.
//
// The sidebar frames are written straight to bob's socket and member_update /
// roles_update go through the hub's dispatch loop in round order, so the order
// on each socket is deterministic and nothing here needs expectEither.
func journeyRoleEdit(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	role, err := r.db.GetRoleByID(context.Background(), roleIDMember)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID(%d): %v", roleIDMember, err)
	}

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	color := "#3366cc"
	r.applyRoleEdit(t, aliceID, roleIDMember, service.RoleInput{Color: &color})
	a.expect("roles_update")
	b.expect("roles_update")

	name := "Regular"
	perms := role.Permissions &^ permissions.SendMessages
	r.applyRoleEdit(t, aliceID, roleIDMember, service.RoleInput{Name: &name, Permissions: &perms})
	b.expect("channel_create")
	b.expect("channel_create")
	b.expect("member_update")
	b.expect("roles_update")
	a.expect("member_update")
	a.expect("roles_update")
	a.barrier()
	b.barrier()
}

// journeyUserUpdate records the profile broadcast through the real PATCH
// /api/v1/users/me route, in both forms: alice's update carries every optional
// field (avatar, display name, about, identity key, banner colour), bob's
// carries them as null where he has none. user_update replaces the receiving
// client's copy wholesale, so the nulls are part of the contract. The frame
// reaches both sockets, the sender's included.
func journeyUserUpdate(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	_ = aliceID
	rest := r.mountREST(t)

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	rest.do(t, http.MethodPatch, "/api/v1/users/me/", aliceTok, map[string]any{
		"username": "alice", "about": "edited fixture profile text", "banner_color": "#112233",
	}, http.StatusOK)
	a.expect("user_update")
	b.expect("user_update")

	rest.do(t, http.MethodPatch, "/api/v1/users/me/", bobTok, map[string]any{
		"username": "bob", "display_name": "Bob Fixture",
	}, http.StatusOK)
	a.expect("user_update")
	b.expect("user_update")
	a.barrier()
	b.barrier()
}

// journeyMemberBan records a ban twice. carol never connects: her ban is the
// plain broadcast, member_ban to every connected client. bob is connected when
// he is banned, so his socket is told BANNED (an error frame that makes the
// client clear its credentials) and closed.
//
// What the banned socket receives besides that error is a race inside the
// server: member_ban goes through the dispatch loop while the error is queued
// by the caller, and the close can land before or after the dispatch delivers.
// So bob's side records the error alone and the journey asserts only that
// nothing other than error and member_ban reaches him before the close.
func journeyMemberBan(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	carolID, _ := r.seedUser(t, "carol")

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	r.applyBan(t, aliceID, carolID)
	a.expect("member_ban")
	b.expect("member_ban")

	r.applyBan(t, aliceID, bobID)
	b.expectBannedClose()
	a.expect("member_ban")
	a.barrier()
}

// expectBannedClose reads a banned socket to its close: it must receive the
// BANNED error (recorded), may receive the member_ban about itself (not
// recorded: whether it arrives before the close is a race), and nothing else.
func (c *wsConn) expectBannedClose() {
	c.t.Helper()
	was := c.record
	c.record = false
	var errFrame map[string]any
	for {
		ctx, cancel := context.WithTimeout(context.Background(), frameDeadline)
		_, raw, err := c.conn.Read(ctx)
		cancel()
		if err != nil {
			if _, isClose := errors.AsType[websocket.CloseError](err); !isClose {
				c.t.Fatalf("conn %q: expected a WebSocket close after the ban, got %v", c.name, err)
			}
			break
		}
		frame := decodeFrame(c.t, raw)
		switch frame["type"] {
		case "error":
			errFrame = frame
		case "member_ban":
		default:
			c.t.Fatalf("conn %q: unexpected %q before the close: %s", c.name, frame["type"], canonicalJSON(c.t, frame))
		}
	}
	c.record = was
	if errFrame == nil {
		c.t.Fatalf("conn %q: closed without the BANNED error frame", c.name)
	}
	if c.record {
		c.tr.add(c.name, "s2c", errFrame)
	}
}

// expectLowAnywhere reads len(ordered)+1 frames: the ordered normal-priority
// frames in exactly that order, plus one LOW-priority frame (low) that may sit
// anywhere among them. It records low first, then ordered. A low frame queued
// alongside normal ones is written whenever the write pump next looks at its
// queues, so its position relative to them is a race (see the note above
// restRig), but the normal frames among themselves are FIFO.
func (c *wsConn) expectLowAnywhere(low string, ordered ...string) {
	c.t.Helper()
	was := c.record
	c.record = false
	frames := make([]map[string]any, 0, len(ordered)+1)
	for range len(ordered) + 1 {
		frames = append(frames, c.read())
	}
	c.record = was

	var lowFrame map[string]any
	rest := make([]map[string]any, 0, len(ordered))
	for _, f := range frames {
		if f["type"] == low && lowFrame == nil {
			lowFrame = f
			continue
		}
		rest = append(rest, f)
	}
	if lowFrame == nil || len(rest) != len(ordered) {
		c.t.Fatalf("conn %q: expected one %q among %v, got %d frames: %v", c.name, low, ordered, len(frames), frameTypes(frames))
	}
	for i, f := range rest {
		if f["type"] != ordered[i] {
			c.t.Fatalf("conn %q: expected %v (plus %q anywhere), got %v", c.name, ordered, low, frameTypes(frames))
		}
	}
	if c.record {
		c.tr.add(c.name, "s2c", lowFrame)
		for _, f := range rest {
			c.tr.add(c.name, "s2c", f)
		}
	}
}

func frameTypes(frames []map[string]any) []any {
	out := make([]any, len(frames))
	for i, f := range frames {
		out[i] = f["type"]
	}
	return out
}

// journeyMemberTimeout records a timeout issued and then lifted, through the
// real moderation service wired to the hub as api/router.go wires it. The
// mod_action here carries expires_at set (the warning in moderation-queue
// carries null), and the same service call fans out three more things:
//
//   - bob (the target): mod_action, member_timeouts (his own entry only; the
//     lift replaces it with an empty list), and a channel_create per visible
//     channel re-sent with can_send false (true again after the lift).
//   - alice (Admin, a moderator): member_timeouts with the full list.
//
// mod_action is LOW priority, the other three are normal, so its place among
// bob's frames is a race: expectLowAnywhere pins the normal frames' order and
// records mod_action first. Each step is read on both sockets before the next.
func journeyMemberTimeout(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	r.svc.Moderation.SetNotifier(r.hub)
	ctx := context.Background()

	a, b := r.dial(t, "a"), r.dial(t, "b")
	a.authenticate(aliceTok)
	b.authenticate(bobTok)
	a.drain("member_join", "presence_batch")

	a.record, b.record = true, true
	if _, err := r.svc.Moderation.Timeout(ctx, aliceID, bobID, "fixture timeout", 10*time.Minute, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	b.expectLowAnywhere("mod_action", "member_timeouts", "channel_create", "channel_create")
	a.expect("member_timeouts")

	if err := r.svc.Moderation.LiftTimeout(ctx, aliceID, bobID); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	b.expectLowAnywhere("mod_action", "member_timeouts", "channel_create", "channel_create")
	a.expect("member_timeouts")
	a.barrier()
	b.barrier()
}
