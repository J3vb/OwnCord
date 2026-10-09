package admin

// A live v2.2.0-beta.1 bundle showed nine livekit_remove_participant_failed
// records and a run of livekit_companion_log WARNs, but no reason for any of
// them: events.json dropped every attribute. Each event now carries a detail
// object with its non-identifying attributes, string values scrubbed of
// addresses, hosts, URLs, emails, paths and tokens.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
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
		{"open /home/alice/owncord/data/chat.db: permission denied", "open [path]"},
		{`open C:\Users\alice\AppData\owncord.db: access is denied`, "open [path]"},
		{"invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl", "invalid token [token]"},
		{"mkdir /backup: permission denied", "mkdir [path]: permission denied"},
		{"open backups/archive.zip: no such file", "open [path]: no such file"},
		{`open \\nas\share\db: access is denied`, "open [path]: access is denied"},
		{"read tcp: i/o timeout", "read tcp: i/o timeout"},
		{"rtc/participant.go:123 track published", "rtc/participant.go:123 track published"},
		{`could not restart {"room": "channel-3", "participant": "alice", "pID": "PA_x", "error": "ice failed"}`, `could not restart {"room": "[redacted]", "participant": "[redacted]", "pID": "[redacted]", "error": "ice failed"}`},
		{"join refused user=alice reason=full", "join refused user=[redacted] reason=full"},
		{"dial tcp nas:7880: connect: connection refused", "dial tcp [host]:7880: connect: connection refused"},
		{"dial tcp localhost:7880: i/o timeout", "dial tcp [host]:7880: i/o timeout"},
		{"bad secret abcdefghijklmnopqrstuvwx rejected", "bad secret [token] rejected"},
		{"open /home/alice smith/x", "open [path]"},
		{"lookup chat.example.rs: no such host", "lookup [host]: no such host"},
		{"lookup chat.example.md: no such host", "lookup [host]: no such host"},
		{"auth failed: Bearer private-token", "auth failed: Bearer [redacted]"},
		{"Authorization: Basic dXNlcjpwYXNz", "Authorization: [redacted]"},
		{"password: hunter2 rejected", "password: [redacted] rejected"},
		{"bad token Xy9q rejected", "bad token [redacted] rejected"},
		{"token expired", "token expired"},
		{"server v2.2.0-beta.1 at 2026-10-08T12:00:00.5Z", "server v2.2.0-beta.1 at 2026-10-08T12:00:00.5Z"},
	}
	for _, c := range cases {
		if got := supportScrub(c.in, nil); got != c.want {
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

func TestSupportScrub_KnownValues(t *testing.T) {
	cfg := &config.Config{}
	cfg.Server.Name = "Bunker Chat"
	cfg.Voice.LiveKitURL = "ws://lkbox:7880"
	known := newSupportKnown(supportKnownValues(cfg, []string{"alice", "Alice Smith", "ab", "!!", "😀😀"}))

	cases := []struct{ in, want string }{
		{"user alice not found", "user [name] not found"},
		{"user ALICE not found", "user [name] not found"},
		{"user Alice Smith not found", "user [name] not found"},
		{"alicetown is fine", "alicetown is fine"},
		{"ab left the call", "[name] left the call"},
		{"cab is not ab", "cab is not [name]"},
		{"Alice  smith joined", "[name] joined"},
		{"malice smithy", "malice smithy"},
		{"user !! not found", "user [name] not found"},
		{"call from 😀😀 dropped", "call from [name] dropped"},
		{"welcome to bunker chat", "welcome to [name]"},
		{"dial lkbox failed", "dial [name] failed"},
	}
	for _, c := range cases {
		if got := supportScrub(c.in, known); got != c.want {
			t.Errorf("supportScrub(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

func TestSupportEvents_RedactsKnownNames(t *testing.T) {
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "RemoveParticipant failed (may already be gone)",
		Attrs: `{"err":"user alice not found"}`})

	got, _ := supportEvents(rb, "alice")[0].Detail["err"].(string)

	if got != "user [name] not found" {
		t.Fatalf("err = %q", got)
	}
}

func TestSupportEvents_RedactsNamePastTenThousand(t *testing.T) {
	names := make([]string, 0, 10100)
	for i := range 10100 {
		names = append(names, fmt.Sprintf("user%05d", i))
	}
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "RemoveParticipant failed (may already be gone)",
		Attrs: `{"err":"user user10099 not found"}`})

	got, _ := supportEvents(rb, names...)[0].Detail["err"].(string)

	if got != "user [name] not found" {
		t.Fatalf("err = %q", got)
	}
}

func TestSupportScrub_KnownNamesCannotBreakStructuralRedaction(t *testing.T) {
	cases := []struct{ name, in, notWant string }{
		{".", "dial tcp 203.0.113.5:7880: connect: connection refused", "203"},
		{".", "lookup turn.example.com: no such host", "turn"},
		{"/", "open /home/alice/x: permission denied", "alice"},
		{"-", "bad token 123e4567-e89b-12d3-a456-426614174000", "e89b"},
		{"1", "dial 203.0.113.1: refused", "203"},
		{"home", "open /home/alice/x: permission denied", "alice"},
	}
	for _, c := range cases {
		got := supportScrub(c.in, newSupportKnown([]string{c.name}))
		if strings.Contains(got, c.notWant) {
			t.Errorf("name %q: supportScrub(%q) = %q leaks %q", c.name, c.in, got, c.notWant)
		}
	}
}

func TestSupportEvents_LongLiveKitLineKeepsTrailingError(t *testing.T) {
	line := `2026-10-08T12:00:00.000Z	WARN	livekit	rtc/transport.go:88	failed to negotiate	{"room": "[redacted]", "roomID": "[redacted]", "participant": "[redacted]", "pID": "[redacted]", "remote": "[redacted]", "transport": "SUBSCRIBER", "trackID": "[redacted]", "kind": "video", "error": "no candidate pairs"}`
	line = strings.Replace(line, "failed to negotiate", strings.Repeat("negotiation detail ", 60), 1)
	attrs, _ := json.Marshal(map[string]any{"line": line})
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "livekit companion output", Attrs: string(attrs)})

	got, _ := supportEvents(rb)[0].Detail["line"].(string)

	if !strings.Contains(got, "…") || !strings.Contains(got, `"error": "no candidate pairs"`) || len(got) > supportDetailMaxValue+4 {
		t.Fatalf("line = %q", got)
	}
}
