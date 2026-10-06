package main

// The single-container image bundles livekit-server and the server starts it
// as its companion process. None of that is exercised by `go test` at runtime,
// so this pins the three files that must agree: Dockerfile, docker-compose.yml
// and ws.DefaultLiveKitVersion.

import (
	"os"
	"regexp"
	"testing"

	"github.com/J3vb/OwnCord/Server/ws"
)

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
	for _, arch := range []string{"AMD64", "ARM64"} {
		if !regexp.MustCompile(`(?m)^ARG LIVEKIT_SHA256_` + arch + `=[0-9a-f]{64}$`).MatchString(df) {
			t.Errorf("Dockerfile must pin a 64-hex LIVEKIT_SHA256_%s", arch)
		}
	}
	if !regexp.MustCompile(`sha256sum -c`).MatchString(df) {
		t.Error("Dockerfile must verify the livekit archive with sha256sum -c")
	}
	if !regexp.MustCompile(`(?m)^ENV .*OWNCORD_VOICE_LIVEKIT_BINARY=/livekit-server\b`).MatchString(df) {
		t.Error("image must point voice.livekit_binary at the bundled binary")
	}
	if !regexp.MustCompile(`COPY --from=\S+ /livekit-server /livekit-server`).MatchString(df) {
		t.Error("image must copy the bundled livekit-server to /livekit-server")
	}
}

func TestComposeKeepsLiveKitSeparate(t *testing.T) {
	dc := readFile(t, "docker-compose.yml")

	// The image defaults to a bundled LiveKit; the two-container stack must
	// opt out or it would start a second one on ports nothing publishes.
	if !regexp.MustCompile(`(?m)^\s+OWNCORD_VOICE_LIVEKIT_BINARY: ""$`).MatchString(dc) {
		t.Error("compose must clear OWNCORD_VOICE_LIVEKIT_BINARY for the separate livekit service")
	}
	// The image defaults to one UDP port; compose publishes the range.
	if !regexp.MustCompile(`(?m)^\s+OWNCORD_VOICE_UDP_PORT: "0"$`).MatchString(dc) {
		t.Error("compose must reset OWNCORD_VOICE_UDP_PORT to 0 to match the published range")
	}
}
