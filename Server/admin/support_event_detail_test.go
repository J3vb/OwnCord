package admin

// A live v2.2.0-beta.1 bundle showed nine livekit_remove_participant_failed
// records and a run of livekit_companion_log WARNs, but no reason for any of
// them: events.json dropped every attribute. Each event now carries a detail
// object with its non-identifying attributes, string values scrubbed of
// addresses, hosts, URLs, emails, paths and tokens.

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestSupportEvents_KeepsErrorReasonWithoutIdentifiers(t *testing.T) {
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "RemoveParticipant failed (may already be gone)",
		Attrs: `{"caller":"leave","err":"twirp error not_found: participant does not exist","user_id":42,"channel_id":7}`})

	events := supportEvents(rb)

	want := map[string]any{"caller": "leave", "err": "twirp error not_found: participant does not exist"}
	if len(events) != 1 || events[0].Event != "livekit_remove_participant_failed" || !reflect.DeepEqual(events[0].Detail, want) {
		t.Fatalf("events = %+v, want one livekit_remove_participant_failed with detail %v", events, want)
	}
}

func TestSupportIdentifyingKey(t *testing.T) {
	for _, key := range []string{
		"user_id", "id", "channel_id", "actor_id", "target_id", "msg_id", "userID", "pID", "roomID", "sid",
		"username", "user", "name", "display_name", "email", "ip", "remote", "remoteAddr", "addr", "host",
		"hostname", "path", "dir", "file", "url", "uri", "token", "token_id", "api_key", "key", "secret",
		"password", "cookie", "session", "auth", "participant", "identity", "room", "channel", "stored_as",
		"backup", "upload", "value", "label", "note", "content", "text", "body", "query", "origin",
		"recipient", "sender", "actor", "target", "peer", "client", "req.user_id", "domain", "endpoint",
	} {
		if !supportIdentifyingKey(key) {
			t.Errorf("supportIdentifyingKey(%q) = false, want true", key)
		}
	}
	for _, key := range []string{"err", "error", "caller", "reason", "status", "attempt", "kind", "msg_type", "bytes", "retry_after_ms", "component", "line", "handler", "type", "invalid_count", "replays"} {
		if supportIdentifyingKey(key) {
			t.Errorf("supportIdentifyingKey(%q) = true, want false", key)
		}
	}
}

func TestSupportScrub(t *testing.T) {
	cases := []struct{ in, want string }{
		{"context deadline exceeded", "context deadline exceeded"},
		{"dial tcp 203.0.113.5:7880: connect: connection refused", "dial tcp [ip]:7880: connect: connection refused"},
		{"dial tcp [2001:db8::1]:7880: i/o timeout", "dial tcp [[ip]]:7880: i/o timeout"},
		{"lookup turn.example.com: no such host", "lookup [host]: no such host"},
		{"Post \"https://lk.example.org/twirp/livekit.RoomService/RemoveParticipant\": EOF", "Post \"[url]\": EOF"},
		{"mail to alice@example.com bounced", "mail to [email] bounced"},
		{"open /home/alice/owncord/data/chat.db: permission denied", "open [path]: permission denied"},
		{`open C:\Users\alice\AppData\owncord.db: access is denied`, "open [path]: access is denied"},
		{"invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl", "invalid token [token]"},
		{"rtc/participant.go:123 track published", "rtc/participant.go:123 track published"},
		{`could not restart {"room": "channel-3", "participant": "alice", "pID": "PA_x", "error": "ice failed"}`, `could not restart {"room": "[redacted]", "participant": "[redacted]", "pID": "[redacted]", "error": "ice failed"}`},
		{"join refused user=alice reason=full", "join refused user=[redacted] reason=full"},
		{"server v2.2.0-beta.1 at 2026-10-08T12:00:00.5Z", "server v2.2.0-beta.1 at 2026-10-08T12:00:00.5Z"},
	}
	for _, c := range cases {
		if got := supportScrub(c.in); got != c.want {
			t.Errorf("supportScrub(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

func TestSupportEvents_LiveKitLineScrubbed(t *testing.T) {
	line := `2026-10-08T12:00:00.000Z	WARN	livekit	rtc/transport.go:88	ICE failed	{"room": "channel-3", "participant": "alice", "remote": "198.51.100.9:50000", "error": "no candidate pairs"}`
	attrs, _ := json.Marshal(map[string]any{"line": line, "component": "livekit"})
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "livekit companion output", Attrs: string(attrs)})

	got, _ := supportEvents(rb)[0].Detail["line"].(string)
	if !strings.Contains(got, "ICE failed") || !strings.Contains(got, "no candidate pairs") {
		t.Fatalf("reason lost from companion line: %q", got)
	}
	for _, leak := range []string{"alice", "channel-3", "198.51.100.9"} {
		if strings.Contains(got, leak) {
			t.Fatalf("companion line leaked %q: %q", leak, got)
		}
	}
}

func TestSupportEvents_DropsNonScalarAndUnparsableAttrs(t *testing.T) {
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "ERROR", Message: "backup maintenance failed", Attrs: `{"cfg":{"secret":"x"},"list":["x"],"ok":true,"n":3}`})
	rb.Write(LogEntry{Timestamp: ts(1), Level: "ERROR", Message: "backup maintenance failed", Attrs: `not json planted-secret`})

	events := supportEvents(rb)

	if want := map[string]any{"ok": true, "n": float64(3)}; !reflect.DeepEqual(events[0].Detail, want) {
		t.Fatalf("detail = %v, want %v", events[0].Detail, want)
	}
	if events[1].Detail != nil {
		t.Fatalf("unparsable attrs produced detail %v", events[1].Detail)
	}
}

// The bundle refuses to build when events.json passes supportMaxBytes, so the
// detail must stay bounded however long or numerous the attributes are.
func TestSupportEvents_DetailStaysWithinItemLimit(t *testing.T) {
	attrs := map[string]any{}
	for _, k := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"} {
		attrs["err_"+k] = strings.Repeat("<\"\x01", 4000)
	}
	raw, _ := json.Marshal(attrs)
	rb := NewRingBuffer(500)
	for i := range 500 {
		rb.Write(LogEntry{Timestamp: ts(i), Level: "ERROR", Message: "backup maintenance failed", Attrs: string(raw)})
	}

	events := supportEvents(rb)

	data, err := json.MarshalIndent(events, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > supportMaxBytes {
		t.Fatalf("events.json is %d bytes, over the %d item limit", len(data), supportMaxBytes)
	}
	if events[len(events)-1].Detail == nil {
		t.Fatal("newest event lost its detail")
	}
}
