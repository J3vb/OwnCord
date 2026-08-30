package ws

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// Inbound protocol parsing, fuzzed at the two seams a hostile client can
// reach: the envelope every frame arrives in, and the per-command payload
// decoders the envelope's type selects.
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
// <token:string>, <id:number>) replaced by concrete values. A plain
// `go test ./ws` replays it, so CI's fuzz replay covers the real wire and not
// only the hand-written shapes seeded below.

// envelopeLogFieldCap mirrors the cap handleMessageDecode applies to the
// client-controlled type and id before they reach a log line.
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

	seeds := []struct {
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
	for _, s := range seeds {
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
