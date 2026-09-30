package ws_test

import (
	"os"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/ws"
	"go.yaml.in/yaml/v3"
)

// Single-port UDP (O1, theme 4). LiveKit can carry all WebRTC media on one UDP
// port instead of the 50000-60000 range, so an owner forwards one port rather
// than ten thousand. voice.udp_port selects it; 0 keeps the shipped range.

type generatedRTC struct {
	UDPPort        int    `yaml:"udp_port"`
	PortRangeStart int    `yaml:"port_range_start"`
	PortRangeEnd   int    `yaml:"port_range_end"`
	NodeIP         string `yaml:"node_ip"`
}

func generateFor(t *testing.T, cfg *config.VoiceConfig) generatedRTC {
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
	var parsed struct {
		Rtc generatedRTC `yaml:"rtc"`
	}
	if err := yaml.Unmarshal(content, &parsed); err != nil {
		t.Fatalf("generated config is not valid YAML: %v\n%s", err, content)
	}
	return parsed.Rtc
}

// With voice.udp_port set, the generated file carries the single port and must
// NOT carry the range — LiveKit ignores port_range_start/end once udp_port is
// set, and leaving them in would tell an operator to forward ports the server
// never binds.
func TestGenerateConfig_SinglePortUDP(t *testing.T) {
	t.Parallel()

	rtc := generateFor(t, &config.VoiceConfig{
		LiveKitAPIKey:    "testkey",
		LiveKitAPISecret: "testsecret",
		LiveKitURL:       "ws://localhost:7880",
		UDPPort:          7882,
	})

	if rtc.UDPPort != 7882 {
		t.Errorf("udp_port = %d, want 7882", rtc.UDPPort)
	}
	if rtc.PortRangeStart != 0 || rtc.PortRangeEnd != 0 {
		t.Errorf("range should be absent, got %d-%d", rtc.PortRangeStart, rtc.PortRangeEnd)
	}
}

// voice.udp_port = 0 (the default) keeps the range exactly as before, so an
// existing install is unaffected by the upgrade.
func TestGenerateConfig_DefaultKeepsPortRange(t *testing.T) {
	t.Parallel()

	rtc := generateFor(t, &config.VoiceConfig{
		LiveKitAPIKey:    "testkey",
		LiveKitAPISecret: "testsecret",
		LiveKitURL:       "ws://localhost:7880",
		UDPPort:          0,
	})

	if rtc.PortRangeStart != 50000 || rtc.PortRangeEnd != 60000 {
		t.Errorf("range = %d-%d, want 50000-60000", rtc.PortRangeStart, rtc.PortRangeEnd)
	}
	if rtc.UDPPort != 0 {
		t.Errorf("default config should not carry udp_port, got %d", rtc.UDPPort)
	}
}

// The single port must sit with the address keys in the same rtc block, so a
// node_ip still pins the advertised address in single-port mode.
func TestGenerateConfig_SinglePortKeepsNodeIP(t *testing.T) {
	t.Parallel()

	rtc := generateFor(t, &config.VoiceConfig{
		LiveKitAPIKey:    "key1",
		LiveKitAPISecret: "secret1",
		LiveKitURL:       "ws://localhost:7880",
		NodeIP:           "203.0.113.10",
		UDPPort:          7883,
	})

	if rtc.UDPPort != 7883 {
		t.Errorf("udp_port = %d, want 7883", rtc.UDPPort)
	}
	if rtc.NodeIP != "203.0.113.10" {
		t.Errorf("single-port mode dropped node_ip, got %q", rtc.NodeIP)
	}
}
