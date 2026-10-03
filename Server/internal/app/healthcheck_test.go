package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// The Docker HEALTHCHECK peeks at config.yaml and the environment. It must also
// read the panel's overrides file, or a port or scheme changed from the panel
// leaves the probe hitting the old address.
func TestHealthcheckProbeReadsOverridesFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("server:\n  data_dir: \""+filepath.ToSlash(dir)+"\"\n  port: 8443\n"), 0o600); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
	if err := os.WriteFile(config.OverridesPath(dir), []byte(`{"server.port": 9443, "tls.mode": "off"}`), 0o600); err != nil {
		t.Fatalf("write overrides: %v", err)
	}

	p := resolveHealthcheckProbe(cfgPath)
	if p.port != 9443 {
		t.Errorf("port = %d, want the panel override 9443", p.port)
	}
	if p.scheme != "http" {
		t.Errorf("scheme = %q, want http (tls.mode off from the panel)", p.scheme)
	}

	// The environment still wins over the panel.
	t.Setenv("OWNCORD_SERVER_PORT", "9999")
	if p := resolveHealthcheckProbe(cfgPath); p.port != 9999 {
		t.Errorf("port = %d, want the environment's 9999", p.port)
	}
}
