package app

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// TestPushDispatchGate_FollowsEnabledOnly pins that push.enabled alone gates
// the dispatcher startHub builds, and that the deprecated
// push.dispatch_enabled changes nothing either way.
func TestPushDispatchGate_FollowsEnabledOnly(t *testing.T) {
	cases := []struct {
		name       string
		enabled    bool
		deprecated bool
		want       bool
	}{
		{"off (compiled default)", false, false, false},
		{"on, deprecated key off (an upgraded install)", true, false, true},
		{"off, deprecated key on", false, true, false},
		{"on, deprecated key on", true, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := &config.Config{Push: config.PushConfig{Enabled: c.enabled, DispatchEnabled: c.deprecated}}
			if got := pushDispatchEnabled(cfg); got != c.want {
				t.Errorf("Enabled=%v deprecated=%v: pushDispatchEnabled = %v, want %v", c.enabled, c.deprecated, got, c.want)
			}
		})
	}
}
