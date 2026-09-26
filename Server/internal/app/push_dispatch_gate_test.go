package app

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// TestPushDispatchGate_RequiresBothKeys pins the "&&" in pushDispatchEnabled
// (startHub's guard before it constructs a PushDispatcher and installs it
// on MessageService): storage on with dispatch off is the B5-4 state and
// must never dispatch, even though it is the state an upgraded install
// starts in. Turning either "||" would make this red.
func TestPushDispatchGate_RequiresBothKeys(t *testing.T) {
	cases := []struct {
		name     string
		enabled  bool
		dispatch bool
		want     bool
	}{
		{"both off (compiled default)", false, false, false},
		{"storage on, dispatch off (the B5-4 state)", true, false, false},
		{"storage off, dispatch on", false, true, false},
		{"both on", true, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := &config.Config{Push: config.PushConfig{Enabled: c.enabled, DispatchEnabled: c.dispatch}}
			if got := pushDispatchEnabled(cfg); got != c.want {
				t.Errorf("Enabled=%v DispatchEnabled=%v: pushDispatchEnabled = %v, want %v", c.enabled, c.dispatch, got, c.want)
			}
		})
	}
}
