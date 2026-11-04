package lkstats

import (
	"context"
	"testing"
)

func TestDeriveURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"ws://livekit:7880", "http://livekit:6789/metrics", true},
		{"wss://lk.example.com", "https://lk.example.com:6789/metrics", true},
		{"wss://lk.example.com:443", "https://lk.example.com:6789/metrics", true},
		{"http://10.0.0.5:7880", "http://10.0.0.5:6789/metrics", true},
		{"https://lk.example.com", "https://lk.example.com:6789/metrics", true},
		{"ws://[::1]:7880", "http://[::1]:6789/metrics", true},
		{"ws://localhost:7880/rtc/path?x=1", "http://localhost:6789/metrics", true},
		{"", "", false},
		{"localhost:7880", "", false},
		{"ftp://livekit:7880", "", false},
		{"ws://", "", false},
		{"ws://bad host:7880", "", false},
		{"://nope", "", false},
	}
	for _, c := range cases {
		got, ok := DeriveURL(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("DeriveURL(%q) = %q, %v; want %q, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestDetect_Pick(t *testing.T) {
	pid := func() (int, bool) { return 0, false }
	rooms := func(context.Context) (int, int, error) { return 0, 0, nil }
	cases := []struct {
		name string
		d    Detect
		want string // "" = no sampler
	}{
		{"voice off", Detect{Managed: true, MetricsURL: "http://x:1/metrics", LiveKitURL: "ws://x:7880"}, ""},
		{"managed wins", Detect{Voice: true, Managed: true, MetricsURL: "http://x:1/metrics", PID: pid, RoomUsage: rooms}, SourceManaged},
		{"configured url", Detect{Voice: true, MetricsURL: "http://x:1/metrics", LiveKitURL: "ws://y:7880"}, SourceMetrics},
		{"derived url", Detect{Voice: true, LiveKitURL: "ws://livekit:7880"}, SourceMetrics},
		{"nothing to guess", Detect{Voice: true, LiveKitURL: "nonsense"}, ""},
	}
	for _, c := range cases {
		s := c.d.Pick(nil)
		switch {
		case c.want == "" && s != nil:
			t.Errorf("%s: got a %q sampler, want none", c.name, s.source)
		case c.want != "" && (s == nil || s.source != c.want):
			t.Errorf("%s: sampler %v, want source %q", c.name, s, c.want)
		}
	}
}
