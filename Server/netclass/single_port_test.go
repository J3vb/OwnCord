package netclass

import (
	"testing"
)

// Single-port UDP (O1): when voice.udp_port is set, the required-ports list
// tells the owner to forward that one UDP port instead of the 50000-60000
// range, so the reachability report matches the livekit.yaml OwnCord writes.
func TestReport_RequiredPortsSinglePortUDP(t *testing.T) {
	r := BuildReport(nil, Params{
		ListenPort:   8443,
		TLSMode:      "off",
		VoiceEnabled: true,
		VoiceUDPPort: 7882,
	})

	var got string
	for _, p := range r.RequiredPorts {
		if p.Protocol == "udp" {
			got = p.Port
		}
	}
	if got != "7882" {
		t.Errorf("voice UDP required port = %q, want the single port 7882", got)
	}
	for _, p := range r.RequiredPorts {
		if p.Port == "50000-60000" {
			t.Error("single-port mode still reports the 50000-60000 range")
		}
	}
}

// Without voice.udp_port the report keeps the range, so an existing install's
// guidance is unchanged.
func TestReport_RequiredPortsDefaultRange(t *testing.T) {
	r := BuildReport(nil, Params{
		ListenPort:   8443,
		TLSMode:      "off",
		VoiceEnabled: true,
	})

	for _, p := range r.RequiredPorts {
		if p.Port == "50000-60000" && p.Protocol == "udp" {
			return
		}
	}
	t.Error("default report no longer lists the UDP range 50000-60000")
}
