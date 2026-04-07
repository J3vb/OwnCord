// Pass 4 — extractEventType tests.
//
// Locks in the Pass 3 byte-scan helper that pulls the wire-format "type"
// field out of a wrapped JSON envelope without a full unmarshal. Tests cover
// the happy paths and the defensive rejects (control chars, escaped quotes,
// length cap, malformed input).
package ws

import (
	"strings"
	"testing"
)

func TestExtractEventType(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    string
	}{
		{"type first", `{"type":"chat_message","seq":1}`, "chat_message"},
		{"seq first", `{"seq":1,"type":"voice_join"}`, "voice_join"},
		{"empty object", `{}`, ""},
		{"missing type", `{"seq":1,"channel":2}`, ""},
		{"control char", "{\"type\":\"with\x01ctrl\"}", ""},
		{"escaped quote", `{"type":"a\"b"}`, ""},
		{"empty type", `{"type":""}`, ""},
		{"empty payload", ``, ""},
		{"non-json", `garbage`, ""},
		{"plausible nested", `{"type":"x","payload":{"type":"y"}}`, "x"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := extractEventType([]byte(c.payload))
			if got != c.want {
				t.Errorf("extractEventType(%q) = %q, want %q", c.payload, got, c.want)
			}
		})
	}
}

func TestExtractEventTypeLengthCap(t *testing.T) {
	long := `{"type":"` + strings.Repeat("a", 100) + `"}`
	if got := extractEventType([]byte(long)); got != "" {
		t.Fatalf("expected empty for >64-char type, got %q", got)
	}
	exactly64 := `{"type":"` + strings.Repeat("a", 64) + `"}`
	if got := extractEventType([]byte(exactly64)); got != strings.Repeat("a", 64) {
		t.Fatalf("64-char type should be accepted, got %q", got)
	}
	exactly65 := `{"type":"` + strings.Repeat("a", 65) + `"}`
	if got := extractEventType([]byte(exactly65)); got != "" {
		t.Fatalf("65-char type should be rejected, got %q", got)
	}
}
