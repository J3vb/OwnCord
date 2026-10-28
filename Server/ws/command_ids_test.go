package ws

import (
	"encoding/json"
	"maps"
	"strings"
	"testing"
)

// idCase names a command, a payload that parses, and the payload fields that
// carry a required positive id (MX-12).
type idCase struct {
	msgType string
	base    map[string]any
	ids     []string
	// newlyChecked marks the ids that accepted 0 and negatives before MX-12.
	newlyChecked bool
}

var requiredIDCases = []idCase{
	{msgType: MsgTypeChatSend, base: map[string]any{"client_message_id": "c1", "channel_id": 1, "content": "hi"}, ids: []string{"channel_id"}, newlyChecked: true},
	{msgType: MsgTypeChatEdit, base: map[string]any{"message_id": 1, "content": "hi"}, ids: []string{"message_id"}, newlyChecked: true},
	{msgType: MsgTypeChatDelete, base: map[string]any{"message_id": 1}, ids: []string{"message_id"}, newlyChecked: true},
	{msgType: MsgTypeReactionAdd, base: map[string]any{"message_id": 1, "emoji": "x"}, ids: []string{"message_id"}, newlyChecked: true},
	{msgType: MsgTypeReactionRemove, base: map[string]any{"message_id": 1, "emoji": "x"}, ids: []string{"message_id"}, newlyChecked: true},
	{msgType: MsgTypeChatForward, base: map[string]any{"client_message_id": "c1", "channel_id": 1, "message_id": 2}, ids: []string{"channel_id", "message_id"}},
	{msgType: MsgTypeTypingStart, base: map[string]any{"channel_id": 1}, ids: []string{"channel_id"}},
	{msgType: MsgTypeCallRing, base: map[string]any{"channel_id": 1}, ids: []string{"channel_id"}},
	{msgType: MsgTypeCallDecline, base: map[string]any{"channel_id": 1}, ids: []string{"channel_id"}},
	{msgType: MsgTypeVoiceJoin, base: map[string]any{"channel_id": 1}, ids: []string{"channel_id"}},
	{msgType: MsgTypeChannelFocus, base: map[string]any{"channel_id": 1}, ids: []string{"channel_id"}},
	{msgType: MsgTypeMarkRead, base: map[string]any{"channel_id": 1, "message_id": 2}, ids: []string{"channel_id"}}, // message_id is optional here
	{msgType: MsgTypeMarkUnread, base: map[string]any{"channel_id": 1, "message_id": 2}, ids: []string{"channel_id", "message_id"}},
	{msgType: MsgTypeVoiceModMute, base: map[string]any{"channel_id": 1, "user_id": 2, "muted": true}, ids: []string{"channel_id", "user_id"}},
	{msgType: MsgTypeVoiceModDeafen, base: map[string]any{"channel_id": 1, "user_id": 2, "deafened": true}, ids: []string{"channel_id", "user_id"}},
	{msgType: MsgTypeVoiceModMove, base: map[string]any{"user_id": 2, "to_channel_id": 3}, ids: []string{"user_id", "to_channel_id"}},
	{msgType: MsgTypeVoiceModKick, base: map[string]any{"user_id": 2}, ids: []string{"user_id"}},
	{msgType: MsgTypePollCreate, base: map[string]any{"client_message_id": "c1", "channel_id": 1, "question": "q", "duration_hours": 0}, ids: []string{"channel_id"}},
	{msgType: MsgTypePollVote, base: map[string]any{"message_id": 1, "answer_ids": []int64{1}}, ids: []string{"message_id"}},
	{msgType: MsgTypePollEnd, base: map[string]any{"message_id": 1}, ids: []string{"message_id"}},
	{msgType: MsgTypeThreadCreate, base: map[string]any{"channel_id": 1, "message_id": 2, "name": "n"}, ids: []string{"channel_id", "message_id"}},
	{msgType: MsgTypeThreadUpdate, base: map[string]any{"thread_id": 1}, ids: []string{"thread_id"}},
	{msgType: MsgTypeThreadDelete, base: map[string]any{"thread_id": 1}, ids: []string{"thread_id"}},
	{msgType: MsgTypeThreadFollow, base: map[string]any{"thread_id": 1, "follow": true}, ids: []string{"thread_id"}},
	{msgType: MsgTypeForumPostCreate, base: map[string]any{"client_message_id": "c1", "channel_id": 1, "name": "n", "content": "c"}, ids: []string{"channel_id"}},
}

// parseWith runs a message type's constructor on a payload.
func parseWith(t *testing.T, msgType string, payload map[string]any) (Command, error) {
	t.Helper()
	ctor, ok := getCommandConstructor(msgType)
	if !ok {
		t.Fatalf("no constructor for %s", msgType)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return ctor(7, "req-1", raw)
}

// withField returns a copy of base with field set to value, or removed when
// value is nil.
func withField(base map[string]any, field string, value any) map[string]any {
	out := maps.Clone(base)
	if value == nil {
		delete(out, field)
	} else {
		out[field] = value
	}
	return out
}

func TestPayloadIDs_BasePayloadsParse(t *testing.T) {
	for _, c := range requiredIDCases {
		if cmd, err := parseWith(t, c.msgType, c.base); err != nil || cmd == nil {
			t.Errorf("%s: base payload = (%v, %v), want a command", c.msgType, cmd, err)
		}
	}
}

func TestPayloadIDs_RequiredIDsRefuseBadValues(t *testing.T) {
	// "x" is not a number, so the JSON decode refuses it before positiveID
	// runs: it still must produce a parse error and no command.
	bad := []struct {
		name  string
		value any
		exact bool
	}{
		{"zero", json.Number("0"), true},
		{"negative", json.Number("-1"), true},
		{"fractional", json.Number("1.5"), true},
		{"missing", nil, true},
		{"string", "x", false},
	}
	for _, c := range requiredIDCases {
		for _, field := range c.ids {
			for _, b := range bad {
				t.Run(c.msgType+"/"+field+"/"+b.name, func(t *testing.T) {
					cmd, err := parseWith(t, c.msgType, withField(c.base, field, b.value))
					if err == nil {
						t.Fatalf("parsed to %#v, want a parse error", cmd)
					}
					if cmd != nil {
						t.Errorf("command = %#v alongside error, want nil", cmd)
					}
					want := field + " must be a positive integer"
					if b.exact && err.Error() != want {
						t.Errorf("error = %q, want %q", err, want)
					}
				})
			}
		}
	}
}

func TestPayloadIDs_ErrorIsBadRequest(t *testing.T) {
	// handleMessage answers every constructor error with this one frame.
	cmd, err := parseWith(t, MsgTypeChatEdit, map[string]any{"message_id": 0, "content": "x"})
	if cmd != nil || err == nil || !strings.Contains(err.Error(), "message_id must be a positive integer") {
		t.Fatalf("parse = (%v, %v), want the positive-integer error", cmd, err)
	}
}

func TestPayloadIDs_OptionalIDsMayBeLeftOut(t *testing.T) {
	cases := []struct {
		name    string
		msgType string
		payload map[string]any
	}{
		{"mark_read without message_id", MsgTypeMarkRead, map[string]any{"channel_id": 1}},
		{"mark_read null message_id", MsgTypeMarkRead, map[string]any{"channel_id": 1, "message_id": nil}},
		{"thread_focus without thread_id", MsgTypeThreadFocus, map[string]any{}},
		{"thread_focus null thread_id", MsgTypeThreadFocus, map[string]any{"thread_id": nil}},
		{"chat_send without reply_to or sticker_id", MsgTypeChatSend, map[string]any{"client_message_id": "c1", "channel_id": 1, "content": "hi"}},
		{"chat_send null reply_to and sticker_id", MsgTypeChatSend, map[string]any{"client_message_id": "c1", "channel_id": 1, "content": "hi", "reply_to": nil, "sticker_id": nil}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, err := json.Marshal(c.payload)
			if err != nil {
				t.Fatal(err)
			}
			ctor, _ := getCommandConstructor(c.msgType)
			if cmd, err := ctor(7, "req-1", raw); err != nil || cmd == nil {
				t.Fatalf("parse = (%v, %v), want a command", cmd, err)
			}
		})
	}
}

func TestPayloadIDs_OptionalIDsStillRefuseBadValuesWhenPresent(t *testing.T) {
	for _, v := range []string{"0", "-1", "1.5"} {
		raw := json.RawMessage(`{"channel_id":1,"message_id":` + v + `}`)
		ctor, _ := getCommandConstructor(MsgTypeMarkRead)
		if cmd, err := ctor(7, "r", raw); err == nil || cmd != nil {
			t.Errorf("mark_read message_id %s = (%v, %v), want a parse error", v, cmd, err)
		}
		raw = json.RawMessage(`{"thread_id":` + v + `}`)
		ctor, _ = getCommandConstructor(MsgTypeThreadFocus)
		if cmd, err := ctor(7, "r", raw); err == nil || cmd != nil {
			t.Errorf("thread_focus thread_id %s = (%v, %v), want a parse error", v, cmd, err)
		}
	}
}

// TestPayloadIDs_ListMatchesNewlyChecked pins the five ids MX-12 started refusing.
func TestPayloadIDs_ListMatchesNewlyChecked(t *testing.T) {
	n := 0
	for _, c := range requiredIDCases {
		if c.newlyChecked {
			n += len(c.ids)
		}
	}
	if n != 5 {
		t.Fatalf("newly checked ids = %d, want 5", n)
	}
}
