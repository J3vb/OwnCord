package main

// The single-container image bundles livekit-server and the server starts it
// as its companion process. None of that is exercised by `go test` at runtime,
// so this pins the livekit version shared by the files that must agree (the
// three below, plus the rest listed in TestLiveKitPinsAgreeEverywhere):
// the Dockerfile's bundled release, docker-compose.yml's separate livekit image
// and ws.DefaultLiveKitVersion.

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/J3vb/OwnCord/Server/ws"
	"go.yaml.in/yaml/v3"
)

type composeService struct {
	Image       string            `yaml:"image"`
	Environment map[string]string `yaml:"environment"`
}

type composeFile struct {
	Services map[string]composeService `yaml:"services"`
}

func readFile(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestDockerfileBundlesPinnedLiveKit(t *testing.T) {
	df := readFile(t, "Dockerfile")

	if m := regexp.MustCompile(`(?m)^ARG LIVEKIT_VERSION=(\S+)$`).FindStringSubmatch(df); len(m) < 2 || m[1] != ws.DefaultLiveKitVersion {
		t.Errorf("Dockerfile LIVEKIT_VERSION must equal ws.DefaultLiveKitVersion %q, got %v", ws.DefaultLiveKitVersion, m)
	}
}

func TestComposeKeepsLiveKitSeparate(t *testing.T) {
	var dc composeFile
	if err := yaml.Unmarshal([]byte(readFile(t, "docker-compose.yml")), &dc); err != nil {
		t.Fatal(err)
	}

	// The image defaults to a bundled LiveKit; the two-container stack must
	// opt out or it would start a second one on ports nothing publishes.
	own := dc.Services["owncord"]
	if v, ok := own.Environment["OWNCORD_VOICE_LIVEKIT_BINARY"]; !ok || v != "" {
		t.Errorf("compose owncord OWNCORD_VOICE_LIVEKIT_BINARY must be empty, got %q (present=%v)", v, ok)
	}
	// The image defaults to one UDP port; compose publishes the range.
	if got := own.Environment["OWNCORD_VOICE_UDP_PORT"]; got != "0" {
		t.Errorf("compose owncord OWNCORD_VOICE_UDP_PORT must be %q, got %q", "0", got)
	}
	// The separate container must run the same release the image bundles.
	if got, want := dc.Services["livekit"].Image, "livekit/livekit-server:v"+ws.DefaultLiveKitVersion; got != want {
		t.Errorf("compose livekit image must be %q, got %q", want, got)
	}
}

// TestLiveKitPinsAgreeEverywhere makes ws.DefaultLiveKitVersion the single
// source of truth for every live copy of the pinned SFU version. A bump that
// misses one (for example the E2E installer or the load workflow) would leave
// those suites testing the old SFU with nothing failing. Each entry reads a
// file relative to the repo root and extracts the version with a pattern whose
// first group is the version; a pattern that no longer matches fails too, so a
// reformatted file cannot pass silently. Historical mentions (changelogs,
// recorded measurements) are deliberately not listed.
func TestLiveKitPinsAgreeEverywhere(t *testing.T) {
	pins := []struct {
		file string // relative to the repo root
		re   string // group 1 is the version
	}{
		{"Server/Dockerfile", `(?m)^ARG LIVEKIT_VERSION=(\S+)$`},
		{"Server/docker-compose.yml", `(?m)^\s*image:\s*livekit/livekit-server:v(\S+)\s*$`},
		{"Server/config.yaml.example", `livekit_version: ""[^\n]*\(e\.g\. "([^"]+)"\)`},
		{"Server/config/config.go", `livekit_version: ""[^\n]*\(e\.g\. "([^"]+)"\)`},
		{"Server/config/config.go", `by auto-download \(e\.g\. "([^"]+)"\)`},
		{"Server/scripts/voice-load.sh", `LIVEKIT_VERSION="\$\{LIVEKIT_VERSION:-([^}]+)\}"`},
		{"Server/scripts/voice-load.sh", `SFU version recorded in the report \(default ([^)]+)\)`},
		{".github/workflows/upgrade-rehearsal.yml", `(?m)^\s*LIVEKIT_VERSION:\s*"([^"]+)"`},
		{".github/workflows/load-baseline.yml", `(?m)^\s*LIVEKIT_VERSION:\s*"([^"]+)"`},
		{"Client/tests/e2e/scripts/install-livekit.mjs", `(?m)^const release = "([^"]+)";`},
		{"Client/voice-join-budget.json", `real server, LiveKit ([0-9][^,\s]*),`},
	}

	for _, p := range pins {
		b, err := os.ReadFile(filepath.Join("..", filepath.FromSlash(p.file)))
		if err != nil {
			t.Errorf("%s: cannot read pinned-version file: %v", p.file, err)
			continue
		}
		m := regexp.MustCompile(p.re).FindStringSubmatch(string(b))
		if len(m) < 2 {
			t.Errorf("%s: LiveKit version pattern %q not found; update the pattern in TestLiveKitPinsAgreeEverywhere if the file was reformatted", p.file, p.re)
			continue
		}
		if m[1] != ws.DefaultLiveKitVersion {
			t.Errorf("%s: LiveKit version is %q, expected %q (ws.DefaultLiveKitVersion)", p.file, m[1], ws.DefaultLiveKitVersion)
		}
	}
}
