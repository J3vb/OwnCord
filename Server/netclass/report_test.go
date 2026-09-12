package netclass

import (
	"net/netip"
	"strings"
	"testing"
)

func addrs(t *testing.T, ss ...string) []netip.Addr {
	t.Helper()
	out := make([]netip.Addr, 0, len(ss))
	for _, s := range ss {
		a, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", s, err)
		}
		out = append(out, a)
	}
	return out
}

func defaultParams() Params {
	return Params{ListenPort: 8443, TLSMode: "self_signed"}
}

// TestReport_InjectedTopologies covers the five shapes an owner actually
// deploys into. Every one is injected: CI cannot produce a real CGNAT or
// hairpin-NAT network, and a test that read this runner's own interfaces would
// assert on GitHub's topology rather than on the classifier.
func TestReport_InjectedTopologies(t *testing.T) {
	cases := []struct {
		name       string
		addrs      []string
		wantGlobal bool
		wantCGNAT  bool
		wantKinds  []Kind
	}{
		{
			name:       "VPS with one public IPv4",
			addrs:      []string{"127.0.0.1", "93.184.216.34"},
			wantGlobal: true,
			wantKinds:  []Kind{KindLoopback, KindGlobal},
		},
		{
			name:       "home server behind NAT",
			addrs:      []string{"127.0.0.1", "192.168.1.50"},
			wantGlobal: false,
			wantKinds:  []Kind{KindLoopback, KindPrivate},
		},
		{
			name:       "CGNAT or Tailscale host",
			addrs:      []string{"127.0.0.1", "192.168.1.50", "100.64.1.2"},
			wantGlobal: false,
			wantCGNAT:  true,
			wantKinds:  []Kind{KindLoopback, KindPrivate, KindCGNAT},
		},
		{
			name:       "IPv6-only host",
			addrs:      []string{"::1", "2606:4700::1111"},
			wantGlobal: true,
			wantKinds:  []Kind{KindLoopback, KindGlobal},
		},
		{
			name:       "loopback only",
			addrs:      []string{"127.0.0.1"},
			wantGlobal: false,
			wantKinds:  []Kind{KindLoopback},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := BuildReport(addrs(t, tc.addrs...), defaultParams())

			if r.HasGlobalAddress != tc.wantGlobal {
				t.Errorf("HasGlobalAddress = %v, want %v", r.HasGlobalAddress, tc.wantGlobal)
			}
			if r.CGNATRangePresent != tc.wantCGNAT {
				t.Errorf("CGNATRangePresent = %v, want %v", r.CGNATRangePresent, tc.wantCGNAT)
			}
			if len(r.LocalAddresses) != len(tc.wantKinds) {
				t.Fatalf("LocalAddresses = %d entries, want %d — loopback is reported, never elided",
					len(r.LocalAddresses), len(tc.wantKinds))
			}
			for i, want := range tc.wantKinds {
				if r.LocalAddresses[i].Kind != want {
					t.Errorf("LocalAddresses[%d].Kind = %q, want %q", i, r.LocalAddresses[i].Kind, want)
				}
			}
			if r.ListenPort != 8443 {
				t.Errorf("ListenPort = %d, want 8443", r.ListenPort)
			}
			if !r.BindsAllInterfaces {
				t.Error("BindsAllInterfaces = false; the server binds \":port\" unconditionally")
			}
		})
	}
}

// TestReport_CGNATIsObservedNeverConcluded is the honesty rule in test form.
// docs/tailscale.md:19-24 documents Tailscale handing out addresses from
// 100.64.0.0/10, so a 100.x address is evidence of two different things and
// the report must name both rather than declare carrier NAT.
func TestReport_CGNATIsObservedNeverConcluded(t *testing.T) {
	r := BuildReport(addrs(t, "100.64.1.2"), defaultParams())

	if !r.CGNATRangePresent {
		t.Fatal("CGNATRangePresent = false for a 100.64/10 address")
	}
	if r.CGNATNote == "" {
		t.Fatal("CGNATRangePresent is true but CGNATNote is empty — the observation must never appear without both explanations")
	}
	lower := strings.ToLower(r.CGNATNote)
	for _, want := range []string{"tailscale", "carrier"} {
		if !strings.Contains(lower, want) {
			t.Errorf("CGNATNote does not mention %q: %q", want, r.CGNATNote)
		}
	}
	if strings.Contains(lower, "you are behind") {
		t.Errorf("CGNATNote states a verdict rather than an observation: %q", r.CGNATNote)
	}

	// And the absence case: no note when there is nothing to explain.
	clean := BuildReport(addrs(t, "192.168.1.50"), defaultParams())
	if clean.CGNATNote != "" {
		t.Errorf("CGNATNote = %q on a host with no CGNAT address, want empty", clean.CGNATNote)
	}
}

// TestReport_AlwaysStatesItsOwnLimits is the milestone's core claim: the
// report never looks confident. Even the fully-public, everything-fine
// topology carries the list of what this server cannot determine from here.
func TestReport_AlwaysStatesItsOwnLimits(t *testing.T) {
	topologies := [][]string{
		{"93.184.216.34"},
		{"192.168.1.50"},
		{"100.64.1.2"},
		{"2606:4700::1111"},
		{"127.0.0.1"},
	}
	for _, topo := range topologies {
		r := BuildReport(addrs(t, topo...), defaultParams())
		if len(r.Undeterminable) == 0 {
			t.Fatalf("Undeterminable is empty for topology %v — it is unconditional", topo)
		}
		for i, u := range r.Undeterminable {
			if u.Fact == "" || u.Why == "" || u.HowToCheck == "" {
				t.Errorf("Undeterminable[%d] for %v has an empty field: %+v — an unknown without a check the owner can run is not actionable", i, topo, u)
			}
		}
	}
}

// TestReport_UndeterminableNamesEveryLimitTheMilestoneListed pins the five
// limits B6-6's outcome sentence enumerates, so removing one is a test change
// rather than a silent narrowing of the honesty contract.
func TestReport_UndeterminableNamesEveryLimitTheMilestoneListed(t *testing.T) {
	r := BuildReport(addrs(t, "192.168.1.50"), defaultParams())

	var b strings.Builder
	for _, u := range r.Undeterminable {
		b.WriteString(" ")
		b.WriteString(strings.ToLower(u.Fact + " " + u.Why))
	}
	joined := b.String()
	for _, want := range []string{"inbound", "carrier-grade nat", "hairpin", "blocked", "changes"} {
		if !strings.Contains(joined, want) {
			t.Errorf("Undeterminable never mentions %q; it must cover blocked ports, CGNAT, hairpin NAT, dynamic IP and inbound reachability", want)
		}
	}
}

// TestReport_RequiredPortsIncludeLiveKitOnlyWhenVoiceIsOn — the LiveKit UDP
// range is where most real port-forward failures happen, and listing it for a
// server with voice switched off would send an owner chasing a rule they do
// not need.
func TestReport_RequiredPortsIncludeLiveKitOnlyWhenVoiceIsOn(t *testing.T) {
	off := BuildReport(addrs(t, "192.168.1.50"), defaultParams())
	for _, p := range off.RequiredPorts {
		if strings.Contains(p.Port, "50000") || p.Port == "7880" || p.Port == "7881" {
			t.Errorf("voice is off but RequiredPorts lists %s/%s", p.Port, p.Protocol)
		}
	}
	if len(off.RequiredPorts) != 1 || off.RequiredPorts[0].Port != "8443" {
		t.Errorf("RequiredPorts = %+v, want just the chat port", off.RequiredPorts)
	}

	p := defaultParams()
	p.VoiceEnabled = true
	on := BuildReport(addrs(t, "192.168.1.50"), p)

	want := map[string]string{"8443": "tcp", "7880": "tcp", "7881": "tcp", "50000-60000": "udp"}
	got := map[string]string{}
	for _, rp := range on.RequiredPorts {
		got[rp.Port] = rp.Protocol
	}
	for port, proto := range want {
		if got[port] != proto {
			t.Errorf("RequiredPorts missing %s/%s; got %+v", port, proto, on.RequiredPorts)
		}
	}
}

// TestReport_NonGlobalVoiceNodeIPIsNamed — a private node_ip hands remote
// clients an unroutable ICE candidate, so voice joins and then silently
// carries no media. The report has to name the kind, not just echo the value.
func TestReport_NonGlobalVoiceNodeIPIsNamed(t *testing.T) {
	p := defaultParams()
	p.VoiceEnabled = true
	p.VoiceNodeIP = "192.168.1.50"

	r := BuildReport(addrs(t, "192.168.1.50"), p)
	if r.VoiceNodeIPKind != KindPrivate {
		t.Errorf("VoiceNodeIPKind = %q, want %q", r.VoiceNodeIPKind, KindPrivate)
	}

	p.VoiceNodeIP = ""
	blank := BuildReport(addrs(t, "192.168.1.50"), p)
	if blank.VoiceNodeIPKind != "" {
		t.Errorf("VoiceNodeIPKind = %q for an unset node_ip, want empty", blank.VoiceNodeIPKind)
	}
}

// TestReport_PublicIPHTTPSIsReportedUnsupported — B6-3 is deferred and nothing
// issues a certificate for a bare public IP. The report says so rather than
// leaving an owner to discover it at handshake time.
func TestReport_PublicIPHTTPSIsReportedUnsupported(t *testing.T) {
	r := BuildReport(addrs(t, "93.184.216.34"), defaultParams())
	if r.PublicIPHTTPSSupported {
		t.Error("PublicIPHTTPSSupported = true; this build cannot request a certificate for an IP address")
	}
	if r.PublicIPHTTPSReason == "" {
		t.Error("PublicIPHTTPSSupported is false with no reason given")
	}
}
