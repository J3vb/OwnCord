package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Inbound protocol parsing, fuzzed at the three seams a hostile client can
// reach: the envelope every frame arrives in, the per-command payload decoders
// the envelope's type selects, and the auth frame — which is decoded before
// any of that, by authenticateConn.
//
// messages.go is almost entirely OUTBOUND builders — parseChannelID is its
// only inbound decoder — so "protocol parsing" is handleMessageDecode
// (handlers.go) plus commandConstructors (command.go). Every constructor in
// that map is a pure function of (userID, reqID, raw), so both targets run
// with no DB, no socket and (for the payloads) no hub at all.
//
// The committed corpus under testdata/fuzz/ is generated from
// protocol/fixtures/epoch-1: every distinct c2s frame of the recorded
// journeys, with the transcript's placeholders (<id:string>, <seq:number>,
// <token:string>, <id:number>) replaced by concrete values, named for the
// journey that owns the frame. A plain `go test ./ws` replays it, so CI's fuzz
// replay covers the real wire and not only the hand-written shapes seeded
// below. Ten command types appear in no journey; their entries carry a minimal
// valid payload instead, and TestCommandPayloadSeedsCoverEveryConstructor
// fails if a newly registered command arrives without one.

// envelopeLogFieldCap mirrors the unnamed 64 at handlers.go:190 and :194 — the
// cap handleMessageDecode applies to the client-controlled type and id before
// they reach a log line. Changing it there must change it here.
const envelopeLogFieldCap = 64

func capLogField(s string) string {
	if len(s) > envelopeLogFieldCap {
		return s[:envelopeLogFieldCap]
	}
	return s
}

// FuzzHandleMessageDecode drives the envelope decoder with arbitrary frames.
// Contract: it accepts exactly the frames that unmarshal into an envelope;
// a rejected frame yields no log fields at all (never a partial success) and
// counts once against the client's consecutive-invalid budget; an accepted
// frame yields the capped envelope fields and re-encodes to something that
// decodes back to an equal envelope.
func FuzzHandleMessageDecode(f *testing.F) {
	seeds := [][]byte{
		nil,
		[]byte(""),
		[]byte(" "),
		[]byte("{}"),
		[]byte("null"),
		[]byte("[]"),
		[]byte("0"),
		[]byte(`"ping"`),
		[]byte(`{"type":"ping"}`),
		[]byte(`{"type":"ping","id":"r1","payload":{}}`),
		[]byte(`{"type":123}`),
		[]byte(`{"id":42}`),
		[]byte(`{"payload":{"channel_id":1}}`),
		[]byte(`{"type":"ping"}{"type":"ping"}`),
		[]byte(`{"type":"ping","payload":null}`),
		[]byte(`{"type":"ping","payload":{"a":1,"a":2}}`),
		[]byte(`{"TYPE":"ping"}`),
		[]byte(`{"type":"\ud800"}`),
		[]byte(`{"type":"a<b&c>d","payload":{"s":"<script>"}}`),
		[]byte(`{"type":"` + strings.Repeat("t", 200) + `"}`),
		[]byte(`{"id":"` + strings.Repeat("i", 200) + `"}`),
		[]byte(`{"type":"` + strings.Repeat("é", 40) + `"}`),
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, raw []byte) {
		// A fresh hub and client per input: the decoder mutates the client's
		// consecutive-invalid counter, so sharing one would make each input's
		// verdict depend on the ones before it.
		hub := NewHubForTest()
		c := NewTestClient(hub, 1, make(chan []byte, 4))

		env, msgType, reqID, ok := hub.handleMessageDecode(c, raw)

		// The probe restates the implementation, so it only pins that the
		// accept/reject split stays a plain envelope unmarshal; the cap, the
		// invalid counter and the round-trip below are the load-bearing checks.
		var probe envelope
		wantOK := json.Unmarshal(raw, &probe) == nil
		if ok != wantOK {
			t.Fatalf("handleMessageDecode(%q) ok = %v, but json.Unmarshal into an envelope succeeds = %v", raw, ok, wantOK)
		}

		c.mu.Lock()
		invalid := c.invalidCount
		c.mu.Unlock()

		if !ok {
			// Rejected: the caller stops, so nothing client-controlled may
			// have been handed back for it to log or dispatch on.
			if msgType != "" || reqID != "" {
				t.Fatalf("handleMessageDecode(%q) rejected the frame but returned msgType %q / reqID %q", raw, msgType, reqID)
			}
			if invalid != 1 {
				t.Fatalf("handleMessageDecode(%q) rejected the frame but left invalidCount = %d, want 1", raw, invalid)
			}
			return
		}

		if invalid != 0 {
			t.Fatalf("handleMessageDecode(%q) accepted the frame but left invalidCount = %d, want 0", raw, invalid)
		}
		if want := capLogField(env.Type); msgType != want {
			t.Fatalf("handleMessageDecode(%q) msgType = %q, want %q (envelope type capped at %d bytes)", raw, msgType, want, envelopeLogFieldCap)
		}
		if want := capLogField(env.ID); reqID != want {
			t.Fatalf("handleMessageDecode(%q) reqID = %q, want %q (envelope id capped at %d bytes)", raw, reqID, want, envelopeLogFieldCap)
		}
		if len(msgType) > envelopeLogFieldCap || len(reqID) > envelopeLogFieldCap {
			t.Fatalf("handleMessageDecode(%q) returned uncapped log fields: msgType %d bytes, reqID %d bytes", raw, len(msgType), len(reqID))
		}

		// Round-trip: a frame that decodes must re-encode to something that
		// decodes back to an equal envelope.
		reencoded, err := json.Marshal(env)
		if err != nil {
			t.Fatalf("handleMessageDecode(%q) accepted the frame but its envelope will not marshal: %v", raw, err)
		}
		var env2 envelope
		if err := json.Unmarshal(reencoded, &env2); err != nil {
			t.Fatalf("handleMessageDecode(%q) envelope re-encoded to %q, which no longer decodes: %v", raw, reencoded, err)
		}
		if env2.Type != env.Type || env2.ID != env.ID {
			t.Fatalf("handleMessageDecode(%q) envelope round-trip changed the header: (%q,%q) -> (%q,%q)", raw, env.Type, env.ID, env2.Type, env2.ID)
		}
		if !equalJSON(t, env.Payload, env2.Payload) {
			t.Fatalf("handleMessageDecode(%q) envelope round-trip changed the payload: %q -> %q", raw, env.Payload, env2.Payload)
		}
	})
}

// equalJSON compares two raw payloads by value rather than by bytes:
// json.Marshal compacts a json.RawMessage and HTML-escapes <, > and & inside
// it, so a byte comparison would report a difference where the decoded value
// is identical.
func equalJSON(t *testing.T, a, b json.RawMessage) bool {
	t.Helper()
	if len(a) == 0 || len(b) == 0 {
		return len(a) == 0 && len(b) == 0
	}
	var av, bv any
	if err := json.Unmarshal(a, &av); err != nil {
		t.Fatalf("payload %q came out of a successful envelope decode but does not itself decode: %v", a, err)
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		t.Fatalf("re-encoded payload %q does not decode: %v", b, err)
	}
	return reflect.DeepEqual(av, bv)
}

// FuzzCommandPayloads drives every registered command's payload decoder.
// Contract: no panic; an error never comes back alongside a command (no
// partial success); a decoded command reports the type it was registered
// under and the AUTHENTICATED sender, never a user id lifted out of the
// payload; and decoding is deterministic.
func FuzzCommandPayloads(f *testing.F) {
	const (
		fuzzUserID = int64(7)
		fuzzReqID  = "req-fuzz"
	)

	for _, s := range commandPayloadSeeds {
		f.Add(s.msgType, []byte(s.payload))
	}

	f.Fuzz(func(t *testing.T, msgType string, payload []byte) {
		ctor, ok := getCommandConstructor(msgType)
		if !ok {
			return
		}

		cmd, err := ctor(fuzzUserID, fuzzReqID, json.RawMessage(payload))
		if err != nil {
			if cmd != nil {
				t.Fatalf("%s(%q) returned command %#v alongside error %v — a rejected payload must yield no command", msgType, payload, cmd, err)
			}
			return
		}
		if cmd == nil {
			t.Fatalf("%s(%q) returned (nil, nil)", msgType, payload)
		}
		if cmd.Type() != msgType {
			t.Fatalf("%s(%q) decoded to a command of type %q", msgType, payload, cmd.Type())
		}
		if cmd.UserID() != fuzzUserID {
			t.Fatalf("%s(%q) decoded to UserID %d, want the authenticated %d — the payload must never set the sender", msgType, payload, cmd.UserID(), fuzzUserID)
		}

		again, err2 := ctor(fuzzUserID, fuzzReqID, json.RawMessage(payload))
		if err2 != nil {
			t.Fatalf("%s(%q) decoded once but failed on the identical second call: %v", msgType, payload, err2)
		}
		if !reflect.DeepEqual(cmd, again) {
			t.Fatalf("%s(%q) is not deterministic: %#v then %#v", msgType, payload, cmd, again)
		}
	})
}

// commandPayloadSeeds is FuzzCommandPayloads' hand-written seed list: the
// adversarial shapes. The valid per-command payloads live in the committed
// corpus, so both halves are checked by
// TestCommandPayloadSeedsCoverEveryConstructor.
var commandPayloadSeeds = []struct {
	msgType string
	payload string
}{
	{MsgTypePing, `{}`},
	{MsgTypeChatSend, `{"channel_id":1,"content":"hello"}`},
	{MsgTypeChatSend, `{"channel_id":"1","content":"","attachments":[],"reply_to":null}`},
	{MsgTypeChatSend, `{"channel_id":1,"user_id":999,"content":"spoof"}`},
	{MsgTypeChatEdit, `{"message_id":1,"content":"edited"}`},
	{MsgTypeChatDelete, `{"message_id":1}`},
	{MsgTypeTypingStart, `{"channel_id":0}`},
	{MsgTypeMarkRead, `{"channel_id":-1}`},
	{MsgTypeChannelFocus, `{"channel_id":1.5}`},
	{MsgTypeReactionAdd, `{"message_id":1,"emoji":"x"}`},
	{MsgTypeVoiceJoin, `{"channel_id":9223372036854775808}`},
	{MsgTypeVoiceLeave, `garbage-not-json`},
	{MsgTypeVoiceModMute, `{"channel_id":1,"user_id":2,"muted":true}`},
	{MsgTypeVoiceModMove, `{"user_id":2,"to_channel_id":0}`},
	{MsgTypeChatCommand, `{"channel_id":1,"command":"   ","args":[]}`},
	{MsgTypeVoiceE2EEOffer, `{"target_user_id":2,"encrypted_key":"AA==","iv":"AA=="}`},
	{"not_a_command", `{}`},
	{"", ``},
}

// corpusFirstString returns the first string(...) argument of every committed
// corpus entry for target — for FuzzCommandPayloads that is the message type.
func corpusFirstString(t *testing.T, target string) []string {
	t.Helper()
	dir := filepath.Join("testdata", "fuzz", target)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading corpus dir %s: %v", dir, err)
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("reading corpus entry %s: %v", e.Name(), err)
		}
		for line := range strings.SplitSeq(string(body), "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "string(") || !strings.HasSuffix(line, ")") {
				continue
			}
			v, uerr := strconv.Unquote(line[len("string(") : len(line)-1])
			if uerr != nil {
				t.Fatalf("corpus entry %s: cannot unquote %s: %v", e.Name(), line, uerr)
			}
			out = append(out, v)
			break
		}
	}
	return out
}

// TestCommandPayloadSeedsCoverEveryConstructor is the guardrail that keeps the
// corpus honest: registering a command in commandConstructors without a seed
// leaves its decoder reachable only if the fuzzer guesses the type string,
// which is not coverage. Ten of the 26 constructors appear in no epoch-1
// journey, so their corpus entries carry a minimal valid payload instead.
func TestCommandPayloadSeedsCoverEveryConstructor(t *testing.T) {
	seeded := make(map[string]bool, len(commandConstructors))
	for _, s := range commandPayloadSeeds {
		seeded[s.msgType] = true
	}
	for _, typ := range corpusFirstString(t, "FuzzCommandPayloads") {
		seeded[typ] = true
	}

	var missing []string
	for typ := range commandConstructors {
		if !seeded[typ] {
			missing = append(missing, typ)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("%d of %d command constructors have no seed or corpus entry: %v\n"+
			"add one to commandPayloadSeeds or to testdata/fuzz/FuzzCommandPayloads/",
			len(missing), len(commandConstructors), missing)
	}

	// The reverse direction: a seed for a type nothing registers is dead
	// weight, and usually a rename that left the corpus behind. The two
	// deliberate negatives are the unregistered-type path itself.
	for typ := range seeded {
		if typ == "" || typ == "not_a_command" {
			continue
		}
		if _, ok := commandConstructors[typ]; !ok {
			t.Errorf("seed/corpus entry for %q, which is not a registered command", typ)
		}
	}
}

// authPayloadMirror mirrors the anonymous struct authenticateConn decodes the
// auth payload into (serve_auth.go:44). auth is deliberately NOT in
// commandConstructors — the handshake runs before the hub knows the client —
// and that decode is inline behind a live websocket read and a session lookup,
// so it cannot be called headlessly. Factoring it out would be a production
// change, which this item may not make; mirroring it is the smallest reachable
// parse, and this comment is the drift warning that buys.
type authPayloadMirror struct {
	Token           string `json:"token"`
	LastSeq         uint64 `json:"last_seq"`
	ActiveChannelID int64  `json:"active_channel_id"`
	Epoch           int    `json:"epoch"`
}

// FuzzAuthPayload drives the handshake frame: envelope, the auth type gate,
// and the payload decode. The property worth fuzzing is that none of the three
// numeric fields a client controls can take a value its Go type cannot hold —
// a last_seq of -1 silently becoming 2^64-1 would let a reconnecting client
// skip its entire replay — and that the token the handshake goes on to hash is
// the string the JSON actually carried.
func FuzzAuthPayload(f *testing.F) {
	seeds := []string{
		`{"type":"auth","payload":{"token":"t","last_seq":0}}`,
		`{"type":"auth","payload":{"token":"t","last_seq":-1}}`,
		`{"type":"auth","payload":{"token":"t","last_seq":18446744073709551616}}`,
		`{"type":"auth","payload":{"token":"t","last_seq":1.5}}`,
		`{"type":"auth","payload":{"token":"t","active_channel_id":9223372036854775808}}`,
		`{"type":"auth","payload":{"token":"t","epoch":-1}}`,
		`{"type":"auth","payload":{"token":"t","epoch":2}}`,
		`{"type":"auth","payload":{"token":"t","epoch":99999999999999999999}}`,
		`{"type":"auth","payload":{"token":""}}`,
		`{"type":"auth","payload":{"token":null}}`,
		`{"type":"auth","payload":{"token":"a","token":"b"}}`,
		`{"type":"auth","payload":[]}`,
		`{"type":"auth"}`,
		`{"type":"AUTH","payload":{"token":"t"}}`,
		`{"type":"ping","payload":{"token":"t"}}`,
	}
	for _, s := range seeds {
		f.Add([]byte(s))
	}

	numeric := []struct {
		key  string
		fits func(string) error
	}{
		{"last_seq", func(s string) error { _, err := strconv.ParseUint(s, 10, 64); return err }},
		{"active_channel_id", func(s string) error { _, err := strconv.ParseInt(s, 10, 64); return err }},
		{"epoch", func(s string) error { _, err := strconv.Atoi(s); return err }},
	}

	f.Fuzz(func(t *testing.T, raw []byte) {
		var env envelope
		if json.Unmarshal(raw, &env) != nil {
			return
		}
		if env.Type != MsgTypeAuth {
			return // serve_auth.go:40 closes the connection before this parse
		}

		var p authPayloadMirror
		structErr := json.Unmarshal(env.Payload, &p)

		var fields map[string]json.RawMessage
		if json.Unmarshal(env.Payload, &fields) != nil {
			if structErr == nil {
				t.Fatalf("auth payload %q is not a JSON object, yet decoding it into the handshake struct succeeded", env.Payload)
			}
			return
		}

		for _, n := range numeric {
			rawField, ok := fields[n.key]
			if !ok {
				continue
			}
			var num json.Number
			if json.Unmarshal(rawField, &num) != nil {
				continue // not a JSON number; the struct decode rejects it too
			}
			if n.fits(string(num)) != nil && structErr == nil {
				t.Fatalf("auth payload %q: %s = %s does not fit its field type, yet the handshake decode succeeded as %+v", env.Payload, n.key, num, p)
			}
		}

		if structErr != nil {
			return
		}
		var wantToken string
		if json.Unmarshal(fields["token"], &wantToken) == nil && wantToken != p.Token {
			t.Fatalf("auth payload %q: token is %q through the handshake struct but %q decoded on its own", env.Payload, p.Token, wantToken)
		}
	})
}
