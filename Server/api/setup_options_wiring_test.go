package api

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// The router must hand the app's background group and shutdown signal to the
// admin API: the update apply tail runs on one and aborts on the other.
func TestAdminSetupOptions_CarryBackgroundAndShutdown(t *testing.T) {
	bg := syncutil.NewGroup(context.Background())
	shutdown := make(chan struct{})
	rt := Runtime{Background: bg, Shutdown: shutdown, SetupToken: "tok"}
	got := adminSetupOptions(&config.Config{}, rt)
	if got.Background != bg {
		t.Error("SetupOptions.Background is not Runtime.Background")
	}
	if got.Shutdown == nil || got.Shutdown != (<-chan struct{})(shutdown) {
		t.Error("SetupOptions.Shutdown is not Runtime.Shutdown")
	}
	if got.SetupToken != "tok" {
		t.Errorf("SetupToken = %q, want tok", got.SetupToken)
	}
}
