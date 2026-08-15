package config

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/knadh/koanf/providers/structs"
	"github.com/knadh/koanf/v2"
)

// TestUnknownFileKeys locks the typo guard: keys the Config struct does not
// define are reported, and every real key — including empty-slice and
// zero-value defaults — is not.
func TestUnknownFileKeys(t *testing.T) {
	k := koanf.New(".")
	if err := k.Load(structs.Provider(defaults(), "koanf"), nil); err != nil {
		t.Fatal(err)
	}
	known := make(map[string]struct{})
	for _, key := range k.Keys() {
		known[key] = struct{}{}
	}

	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	yamlBody := `server:
  prot: 9999
  admin_alowed_cidrs:
    - "0.0.0.0/0"
  allowed_origins:
    - "https://example.com"
  max_ws_connections: 500
databsae:
  path: "oops.db"
backup:
  dir: "elsewhere"
`
	if err := os.WriteFile(cfgPath, []byte(yamlBody), 0o600); err != nil {
		t.Fatal(err)
	}

	unknown := unknownFileKeys(cfgPath, known)
	slices.Sort(unknown)

	want := []string{"databsae.path", "server.admin_alowed_cidrs", "server.prot"}
	if !slices.Equal(unknown, want) {
		t.Fatalf("unknownFileKeys = %v, want %v", unknown, want)
	}
}
