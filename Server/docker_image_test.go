package main

// The single-container image bundles livekit-server and the server starts it
// as its companion process. None of that is exercised by `go test` at runtime,
// so this pins the livekit version shared by the files that must agree (the
// three below, plus the rest listed in TestLiveKitPinsAgreeEverywhere):
// the Dockerfile's bundled release, docker-compose.yml's separate livekit image
// and ws.DefaultLiveKitVersion.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/ws"
	"go.yaml.in/yaml/v3"
)

type composeService struct {
	Image       string            `yaml:"image"`
	Command     string            `yaml:"command"`
	Ports       []string          `yaml:"ports"`
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

func readCompose(t *testing.T) composeFile {
	t.Helper()
	var dc composeFile
	if err := yaml.Unmarshal([]byte(readFile(t, "docker-compose.yml")), &dc); err != nil {
		t.Fatal(err)
	}
	return dc
}

// publishedPorts expands every ports: entry into "port/proto" strings, one per
// host port, so a range counts as many.
func publishedPorts(t *testing.T, dc composeFile) []string {
	t.Helper()
	entry := regexp.MustCompile(`^(?:[^:]+:)?(\d+)(?:-(\d+))?:(\d+)(?:-(\d+))?(?:/(tcp|udp))?$`)
	var out []string
	for name, svc := range dc.Services {
		for _, p := range svc.Ports {
			m := entry.FindStringSubmatch(p)
			if m == nil {
				t.Errorf("service %s: unparseable ports entry %q", name, p)
				continue
			}
			lo, _ := strconv.Atoi(m[1])
			hi := lo
			if m[2] != "" {
				hi, _ = strconv.Atoi(m[2])
			}
			proto := m[5]
			if proto == "" {
				proto = "tcp"
			}
			for port := lo; port <= hi; port++ {
				out = append(out, fmt.Sprintf("%d/%s", port, proto))
			}
		}
	}
	sort.Strings(out)
	return out
}

func TestComposePublishesAtMostThreePorts(t *testing.T) {
	got := publishedPorts(t, readCompose(t))
	want := []string{"7881/tcp", "7882/udp", "8443/tcp"}
	if !slices.Equal(got, want) {
		t.Errorf("compose must publish exactly %v, got %d ports: %v", want, len(got), got[:min(len(got), 10)])
	}
}

func TestComposeUDPPortAgrees(t *testing.T) {
	dc := readCompose(t)

	var udp []string
	for _, p := range publishedPorts(t, dc) {
		if port, ok := strings.CutSuffix(p, "/udp"); ok {
			udp = append(udp, port)
		}
	}
	if len(udp) != 1 {
		t.Fatalf("compose must publish exactly one UDP port, got %d: %v", len(udp), udp[:min(len(udp), 10)])
	}
	port := udp[0]

	cmd := dc.Services["livekit"].Command
	if m := regexp.MustCompile(`--udp-port[ =](\d+)`).FindStringSubmatch(cmd); len(m) < 2 || m[1] != port {
		t.Errorf("livekit command --udp-port must be %s, got %q", port, cmd)
	}
	// A port_range in an operator's old livekit.yaml beats udp_port, so both
	// range flags must zero it.
	for _, flag := range []string{"--rtc.port_range_start", "--rtc.port_range_end"} {
		if !regexp.MustCompile(regexp.QuoteMeta(flag) + `[ =]0(\s|$)`).MatchString(cmd) {
			t.Errorf("livekit command must carry %s 0, got %q", flag, cmd)
		}
	}

	if got := dc.Services["owncord"].Environment["OWNCORD_VOICE_UDP_PORT"]; got != port {
		t.Errorf("owncord OWNCORD_VOICE_UDP_PORT must be %s, got %q", port, got)
	}

	ex := readFile(t, "livekit.yaml.example")
	if m := regexp.MustCompile(`(?m)^\s+udp_port:\s*(\d+)\s*$`).FindStringSubmatch(ex); len(m) < 2 || m[1] != port {
		t.Errorf("livekit.yaml.example rtc.udp_port must be %s, got %v", port, m)
	}
	if regexp.MustCompile(`(?m)^\s*port_range_(start|end):`).MatchString(ex) {
		t.Error("livekit.yaml.example must not set port_range_start/end")
	}
}

func TestComposeLiveKitKeysFromEnv(t *testing.T) {
	dc := readCompose(t)

	keys := dc.Services["livekit"].Environment["LIVEKIT_KEYS"]
	if !regexp.MustCompile(`^'[^']+': '[^']+'$`).MatchString(keys) {
		t.Errorf("livekit LIVEKIT_KEYS must be 'key': 'secret', both single-quoted, got %q", keys)
	}
	for _, v := range []string{"LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"} {
		if !strings.Contains(keys, "${"+v+":?") {
			t.Errorf("livekit LIVEKIT_KEYS must reference ${%s:?...}, got %q", v, keys)
		}
		if got := dc.Services["owncord"].Environment["OWNCORD_VOICE_"+v]; !strings.Contains(got, "${"+v+":?") {
			t.Errorf("owncord must read ${%s:?...}, got %q", v, got)
		}
	}

	if regexp.MustCompile(`(?m)^keys:`).MatchString(readFile(t, "livekit.yaml.example")) {
		t.Error("livekit.yaml.example must not have a keys: block; the pair comes from .env")
	}
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
		matches := regexp.MustCompile(p.re).FindAllStringSubmatch(string(b), -1)
		if len(matches) == 0 {
			t.Errorf("%s: LiveKit version pattern %q not found; update the pattern in TestLiveKitPinsAgreeEverywhere if the file was reformatted", p.file, p.re)
			continue
		}
		for _, m := range matches {
			if m[1] != ws.DefaultLiveKitVersion {
				t.Errorf("%s: LiveKit version is %q, expected %q (ws.DefaultLiveKitVersion)", p.file, m[1], ws.DefaultLiveKitVersion)
			}
		}
	}
}
