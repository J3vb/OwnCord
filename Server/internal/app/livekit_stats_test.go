package app

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

func TestLiveKitStats_OnlyForAnHTTPURL(t *testing.T) {
	cases := map[string]bool{
		"":                              false,
		"ftp://livekit:6789/metrics":    false,
		"livekit:6789/metrics":          false,
		"http://":                       false,
		"http://livekit:6789/metrics":   true,
		"https://lk.example.com/metric": true,
	}
	for raw, want := range cases {
		cfg := &config.Config{}
		cfg.Voice.LiveKitMetricsURL = raw
		if got := liveKitStats(cfg) != nil; got != want {
			t.Errorf("url %q: sampler = %v, want %v", raw, got, want)
		}
	}
}
