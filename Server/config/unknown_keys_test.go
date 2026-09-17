package config

import (
	"slices"
	"testing"

	goyaml "go.yaml.in/yaml/v3"
)

// TestUnknownKeys locks the typo guard: keys the Config struct does not
// define are reported, and every real key — including a bare section header
// and an empty section — is not.
func TestUnknownKeys(t *testing.T) {
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
voice:
  # livekit_url: "ws://localhost:7880"
  # quality: "medium"
`
	var tree map[string]any
	if err := goyaml.Unmarshal([]byte(yamlBody), &tree); err != nil {
		t.Fatal(err)
	}

	got := unknownKeys(tree)

	want := []string{"databsae.path", "server.admin_alowed_cidrs", "server.prot"}
	if !slices.Equal(got, want) {
		t.Fatalf("unknownKeys = %v, want %v", got, want)
	}
}
