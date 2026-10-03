package admin

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// A hand-edited overrides file may keep a non-editable key: ReadOverrides keeps
// it and the boot skips it with a warning. fallbackConfig's reset batch may only
// carry editable keys, so a stray key cannot make Preview reject the batch and
// blank every row's fallback (the panel's post-reset address helper).
func TestFallbackConfig_ToleratesNonEditableOverrideKey(t *testing.T) {
	dataDir := t.TempDir()
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("server:\n  max_ws_connections: 10\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ovPath := config.OverridesPath(dataDir)
	if err := os.WriteFile(ovPath, []byte(`{"server.max_ws_connections": 20, "server.datadir": "/x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	overrides, err := config.ReadOverrides(ovPath)
	if err != nil {
		t.Fatal(err)
	}
	fallback := fallbackConfig(cfgPath, ovPath, overrides)
	if fallback == nil {
		t.Fatal("fallbackConfig = nil; a non-editable key in the file blanked the fallback")
	}
	if fallback.Server.MaxWSConnections != 10 {
		t.Errorf("fallback max_ws = %d, want config.yaml's 10", fallback.Server.MaxWSConnections)
	}
}
