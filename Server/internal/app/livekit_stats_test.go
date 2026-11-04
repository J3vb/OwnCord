package app

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/lkstats"
)

type fakeLiveKitHub struct{ managed bool }

func (f fakeLiveKitHub) LiveKitManaged() bool  { return f.managed }
func (fakeLiveKitHub) LiveKitPID() (int, bool) { return 0, false }
func (fakeLiveKitHub) LiveKitRoomUsage(context.Context) (int, int, error) {
	return 0, 0, nil
}

func TestLiveKitStats_PicksTheSource(t *testing.T) {
	cases := []struct {
		name    string
		voice   bool
		managed bool
		metrics string
		lkURL   string
		want    string
	}{
		{"voice off", false, false, "http://livekit:6789/metrics", "ws://livekit:7880", ""},
		{"managed", true, true, "http://livekit:6789/metrics", "ws://localhost:7880", lkstats.SourceManaged},
		{"configured", true, false, "http://other:6789/metrics", "ws://livekit:7880", lkstats.SourceMetrics},
		{"guessed", true, false, "", "ws://livekit:7880", lkstats.SourceMetrics},
		{"invalid url falls back to the guess", true, false, "ftp://livekit:6789/metrics", "ws://livekit:7880", lkstats.SourceMetrics},
		{"nothing to guess", true, false, "", "", ""},
	}
	for _, c := range cases {
		cfg := &config.Config{}
		cfg.Voice.LiveKitMetricsURL, cfg.Voice.LiveKitURL = c.metrics, c.lkURL
		s := liveKitStats(cfg, fakeLiveKitHub{managed: c.managed}, c.voice)
		if c.want == "" {
			if s != nil {
				t.Errorf("%s: want no sampler", c.name)
			}
			continue
		}
		if s == nil {
			t.Errorf("%s: no sampler, want %s", c.name, c.want)
			continue
		}
		// The ring is empty before Run, but the sampler reports its source.
		if got := s.Snapshot(time.Hour, 1).Source; got != c.want {
			t.Errorf("%s: source %q, want %q", c.name, got, c.want)
		}
	}
}
