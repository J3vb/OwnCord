package admin

// A live v2.2.0-beta.1 bundle showed nine livekit_remove_participant_failed
// records and a run of livekit_companion_log WARNs, but no reason for any of
// them: events.json dropped every attribute. Each event now carries a detail
// object with its non-identifying attributes. Free text is reduced to an
// allowlist of error vocabulary: every other word, with the path or host
// punctuation around it, becomes [x].

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

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
		"data", "matched_data",
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

// Error vocabulary, punctuation, single characters and short numbers stay;
// every other word, with the path or host punctuation joining it, is one [x].
func TestSupportScrub(t *testing.T) {
	cases := []struct{ in, want string }{
		{"context deadline exceeded", "context deadline exceeded"},
		{"twirp error not_found: participant does not exist", "twirp error not_found: participant does not exist"},
		{"read tcp: i/o timeout", "read tcp: i/o timeout"},
		{"dial tcp nas:7880: connect: connection refused", "dial tcp [x]:7880: connect: connection refused"},
		{"open /srv/Private Project: permission denied", "open [x]: permission denied"},
		{"dial tcp 203.0.113.5:7880: connect: connection refused", "dial tcp [x]:7880: connect: connection refused"},
		{"dial tcp [2001:db8::1]:7880: i/o timeout", "dial tcp [[x]]:7880: i/o timeout"},
		{"dial tcp [::ffff:203.0.113.5]:7880: i/o timeout", "dial tcp [[x]:[x]]:7880: i/o timeout"},
		{"lookup turn.example.com: no such host", "lookup [x]: no such host"},
		{"mkdir /backup: permission denied", "mkdir [x]: permission denied"},
		{`open "/srv/ab cd": permission denied`, `open "[x]": permission denied`},
		{`could not restart {"room": "channel-3", "participant": "alice", "pID": "PA_x", "error": "ice failed"}`, `could not restart {"room": "[x]", "participant": "[x]", "[x]": "[x]", "error": "ice failed"}`},
		{"join refused user=alice reason=full", "join refused user=[x] reason=full"},
		{"auth failed: Bearer private-token", "auth failed: Bearer [x]"},
		{"Authorization: Basic dXNlcjpwYXNz", "Authorization: [x]"},
		{"password: correct horse battery staple", "password: [x]"},
		{"token expired", "token expired"},
		{"retry after 250ms, status 503", "retry after 250ms, status 503"},
		{"session 1234567 not found", "session [x] not found"},
	}
	for _, c := range cases {
		if got := supportScrub(c.in, nil); got != c.want {
			t.Errorf("supportScrub(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

// Every example raised in review (seven Codex findings and the pipeline's own)
// must not reach events.json.
func TestSupportScrub_ReviewExamplesDoNotLeak(t *testing.T) {
	known := newSupportKnown([]string{"alice", "ab", "!!", "😀😀", "Alice Smith"})
	cases := []struct {
		in    string
		leaks []string
	}{
		{"auth failed: Bearer private-token", []string{"private-token"}},
		{"bad token Xy9q rejected", []string{"Xy9q"}},
		{"user ab left the call", []string{" ab "}},
		{"user !! not found", []string{"!!"}},
		{"call from 😀😀 dropped", []string{"😀😀"}},
		{"user alice not found", []string{"alice"}},
		{"Alice  Smith joined", []string{"Alice", "Smith"}},
		{"mkdir /backup: permission denied", []string{"backup"}},
		{"open backups/archive.zip: no such file", []string{"backups", "archive"}},
		{`open \\nas\share\db: access is denied`, []string{"nas", "share"}},
		{"password: correct horse battery staple", []string{"correct", "horse", "battery", "staple"}},
		{"open /srv/Private Project: permission denied", []string{"srv", "Private", "Project"}},
		{"open /home/alice smith/x: permission denied", []string{"alice", "smith"}},
		{"dial tcp nas:7880: connect: connection refused", []string{"nas"}},
		{"dial tcp localhost:7880: i/o timeout", []string{"localhost"}},
		{"bad secret abcdefghijklmnopqrstuvwx rejected", []string{"abcdefghijklmnopqrstuvwx"}},
		{"lookup chat.example.rs: no such host", []string{"chat", "example"}},
		{"mail to alice@example.com bounced", []string{"alice", "example"}},
		{`Post "https://lk.example.org/twirp/livekit.RoomService/RemoveParticipant": EOF`, []string{"lk.example", "example.org"}},
		{"invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl", []string{"eyJ"}},
		{"bad token 123e4567-e89b-12d3-a456-426614174000", []string{"e89b", "426614174000"}},
	}
	for _, c := range cases {
		got := supportScrub(c.in, known)
		for _, leak := range c.leaks {
			if strings.Contains(got, leak) {
				t.Errorf("supportScrub(%q) = %q leaks %q", c.in, got, leak)
			}
		}
	}
}

// The vocabulary holds error words, never words that name a place or person.
func TestSupportVocabulary_HoldsNoIdentifyingWords(t *testing.T) {
	for _, w := range []string{"private", "project", "home", "users", "example", "com", "org", "localhost", "admin", "root", "alice", "correct", "horse", "battery", "staple", "srv", "nas"} {
		if supportVocabularySet[w] {
			t.Errorf("vocabulary contains %q", w)
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

// Known values catch a name that is also an error word, which the allowlist
// alone would keep.
func TestSupportScrub_KnownValues(t *testing.T) {
	cfg := &config.Config{}
	cfg.Server.Name = "Timeout Club"
	cfg.Voice.LiveKitURL = "ws://connect:7880"
	known := newSupportKnown(supportKnownValues(cfg, []string{"refused", "ab"}))

	cases := []struct{ in, want string }{
		{"user refused not found", "user [x] not found"},
		{"user REFUSED not found", "user [x] not found"},
		{"welcome to timeout club", "welcome to [x]"},
		{"dial connect failed", "dial [x] failed"},
		{"ab left the call", "[x] left the call"},
		{"context deadline exceeded", "context deadline exceeded"},
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
		Attrs: `{"err":"user timeout not found"}`})

	got, _ := supportEvents(rb, "timeout")[0].Detail["err"].(string)

	if got != "user [x] not found" {
		t.Fatalf("err = %q", got)
	}
}

func TestSupportEvents_RedactsNamePastTenThousand(t *testing.T) {
	names := make([]string, 0, 10100)
	for i := range 10100 {
		names = append(names, fmt.Sprintf("user%05d", i))
	}
	names = append(names, "timeout")
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "RemoveParticipant failed (may already be gone)",
		Attrs: `{"err":"user timeout not found"}`})

	got, _ := supportEvents(rb, names...)[0].Detail["err"].(string)

	if got != "user [x] not found" {
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
	line = strings.Replace(line, "failed to negotiate", strings.Repeat("connection refused ", 60), 1)
	attrs, _ := json.Marshal(map[string]any{"line": line})
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "livekit companion output", Attrs: string(attrs)})

	got, _ := supportEvents(rb)[0].Detail["line"].(string)

	if !strings.Contains(got, "…") || !strings.Contains(got, `"error": "no candidate pairs"`) || len(got) > supportDetailMaxValue+4 {
		t.Fatalf("line = %q", got)
	}
}

func TestSupportEvents_DropsWAFMatchedData(t *testing.T) {
	rb := NewRingBuffer(10)
	rb.Write(LogEntry{Timestamp: ts(0), Level: "WARN", Message: "RemoveParticipant failed (may already be gone)",
		Attrs: `{"data":"Matched Data: select found within ARGS:body: meet me at 12 Oak St","err":"not found"}`})

	detail := supportEvents(rb)[0].Detail

	if want := map[string]any{"err": "not found"}; !reflect.DeepEqual(detail, want) {
		t.Fatalf("detail = %v, want %v", detail, want)
	}
}

// A registered name made only of structural characters ("[]", "::") is
// masked where it stands alone, not split into kept separators.
func TestSupportScrub_RedactsStructuralNames(t *testing.T) {
	known := newSupportKnown([]string{"[]", "::"})
	cases := []struct{ in, want string }{
		{"user [] not found", "user [x] not found"},
		{`user "::" not found`, `user "[x]" not found`},
		{"user []: not found", "user [x]: not found"},
		{"dial tcp [x]:7880: i/o timeout", "dial tcp [x]:7880: i/o timeout"},
		{"mention @:: not resolved", "mention [x][x] not resolved"},
	}
	for _, c := range cases {
		if got := supportScrub(c.in, known); got != c.want {
			t.Errorf("supportScrub(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

// An identifying key's embedded JSON array or object is masked whole.
func TestSupportScrub_MasksCompositeJSONValues(t *testing.T) {
	cases := []struct{ in, want string }{
		{`kick {"participant_ids":[12,34,56],"error":"ice failed"}`, `kick {"participant_ids":"[x]","error":"ice failed"}`},
		{`kick {"room":{"id":7,"n":[1,2]},"error":"ice failed"}`, `kick {"room":"[x]","error":"ice failed"}`},
		{`kick {"error":{"room":"b","code":5}}`, `kick {"error":{"room":"[x]","code":5}}`},
		{`kick name: 加藤 failed`, `kick name: [x] failed`},
		{`kick {"participant_ids":[12,"a]",34`, `kick {"participant_ids":"[x]"`},
	}
	for _, c := range cases {
		if got := supportScrub(c.in, nil); got != c.want {
			t.Errorf("supportScrub(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

// Many names sharing a first word must not make each occurrence of that word
// scan them all, or a preview overruns its 3 s timeout: 10,000 names starting
// "User" cost about what one does.
func TestSupportKnown_ManySamePrefixNamesStayFast(t *testing.T) {
	names := make([]string, 0, 10000)
	for i := range 10000 {
		names = append(names, fmt.Sprintf("User %d", i))
	}
	value := strings.Repeat("user ", 1000)
	timeScrub := func(known *supportKnown) time.Duration {
		start := time.Now()
		for range 100 {
			known.scrub(value)
		}
		return time.Since(start)
	}

	one, many := timeScrub(newSupportKnown(names[:1])), timeScrub(newSupportKnown(names))

	if many > 5*one+100*time.Millisecond {
		t.Fatalf("10,000 same-prefix names took %v, one name %v", many, one)
	}
}
