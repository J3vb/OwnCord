package main

// The single-container image bundles livekit-server and the server starts it
// as its companion process. None of that is exercised by `go test` at runtime,
// so this pins the livekit version shared by the three files that must agree:
// the Dockerfile's bundled release, docker-compose.yml's separate livekit image
// and ws.DefaultLiveKitVersion.

import (
	"os"
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

	if m := regexp.MustCompile(`(?m)^ARG LIVEKIT_VERSION=(\S+)$`).FindStringSubmatch(df); m == nil || m[1] != ws.DefaultLiveKitVersion {
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
