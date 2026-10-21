package api

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// A preloaded key (the app's totp-key stage) is used as is: routerTOTPKey must
// not load or generate one of its own.
func TestRouterTOTPKey_UsesPreloadedKey(t *testing.T) {
	t.Setenv("OWNCORD_TOTP_KEY", "")
	dir := filepath.Join(t.TempDir(), "data")
	cfg := &config.Config{}
	cfg.Server.DataDir = dir
	want := bytes.Repeat([]byte{7}, 32)

	got := routerTOTPKey(cfg, want)

	if !bytes.Equal(got, want) {
		t.Fatalf("routerTOTPKey = %x, want the preloaded key %x", got, want)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("data dir stat err = %v, want it never created", err)
	}
}
