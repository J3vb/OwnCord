package ws_test

import (
	"os"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/ws"
	"go.yaml.in/yaml/v3"
)

// Single-port UDP (O1, theme 4). LiveKit can carry all WebRTC media on one UDP
// port instead of the 50000-60000 range, so an owner forwards one port rather
// than ten thousand. voice.udp_port selects it; 0 keeps the shipped range.

func generateFor(t *testing.T, cfg *config.VoiceConfig) string {
	t.Helper()
	proc := ws.NewLiveKitProcess(cfg, &config.TLSConfig{}, t.TempDir())
	cfgPath, err := proc.GenerateConfigForTest()
	if err != nil {
		t.Fatalf("generateConfig: %v", err)
	}
	content, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading config file: %v", err)
	}
	return string(content)
}

// With voice.udp_port set, the generated file carries the single port and must
// NOT carry the range — LiveKit ignores port_range_start/end once udp_port is
// set, and leaving them in would tell an operator to forward ports the server
// never binds.
func TestGenerateConfig_SinglePortUDP(t *testing.T) {
	t.Parallel()

	got := generateFor(t, &config.VoiceConfig{
		LiveKitAPIKey:    "testkey",
		LiveKitAPISecret: "testsecret",
		LiveKitURL:       "ws://localhost:7880",
		UDPPort:          7882,
	})

	if !strings.Contains(got, "udp_port: 7882") {
		t.Errorf("single-port config missing `udp_port: 7882`.\nGot:\n%s", got)
	}
	if strings.Contains(got, "port_range_start") || strings.Contains(got, "port_range_end") {
		t.Errorf("single-port config still carries the UDP range.\nGot:\n%s", got)
	}
	// The rtc block must stay valid YAML with the single port in it.
	var parsed struct {
		Rtc struct {
			UDPPort        int `yaml:"udp_port"`
			PortRangeStart int `yaml:"port_range_start"`
			PortRangeEnd   int `yaml:"port_range_end"`
		} `yaml:"rtc"`
	}
	if err := yaml.Unmarshal([]byte(got), &parsed); err != nil {
		t.Fatalf("generated config is not valid YAML: %v\n%s", err, got)
	}
	if parsed.Rtc.UDPPort != 7882 {
		t.Errorf("parsed udp_port = %d, want 7882", parsed.Rtc.UDPPort)
	}
	if parsed.Rtc.PortRangeStart != 0 || parsed.Rtc.PortRangeEnd != 0 {
		t.Errorf("parsed range should be absent, got %d-%d", parsed.Rtc.PortRangeStart, parsed.Rtc.PortRangeEnd)
	}
}

// voice.udp_port = 0 (the default) keeps the range exactly as before, so an
// existing install is unaffected by the upgrade.
func TestGenerateConfig_DefaultKeepsPortRange(t *testing.T) {
	t.Parallel()

	got := generateFor(t, &config.VoiceConfig{
		LiveKitAPIKey:    "testkey",
		LiveKitAPISecret: "testsecret",
		LiveKitURL:       "ws://localhost:7880",
		UDPPort:          0,
	})

	for _, want := range []string{"port_range_start: 50000", "port_range_end: 60000"} {
		if !strings.Contains(got, want) {
			t.Errorf("default config missing %q.\nGot:\n%s", want, got)
		}
	}
	if strings.Contains(got, "udp_port") {
		t.Errorf("default config should not carry udp_port.\nGot:\n%s", got)
	}
}

// The single port must sit with the address keys in the same rtc block, so a
// node_ip still pins the advertised address in single-port mode.
func TestGenerateConfig_SinglePortKeepsNodeIP(t *testing.T) {
	t.Parallel()

	got := generateFor(t, &config.VoiceConfig{
		LiveKitAPIKey:    "key1",
		LiveKitAPISecret: "secret1",
		LiveKitURL:       "ws://localhost:7880",
		NodeIP:           "203.0.113.10",
		UDPPort:          7883,
	})

	if !strings.Contains(got, "udp_port: 7883") {
		t.Errorf("missing udp_port.\nGot:\n%s", got)
	}
	if !strings.Contains(got, `node_ip: "203.0.113.10"`) {
		t.Errorf("single-port mode dropped node_ip.\nGot:\n%s", got)
	}
}
