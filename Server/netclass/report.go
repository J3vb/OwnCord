package netclass

import (
	"fmt"
	"net"
	"net/netip"
)

// Params is everything BuildReport needs from the server's configuration.
//
// It is a plain struct rather than a *config.Config so this package stays a
// leaf with no dependency on config, and so a test can state a topology
// without constructing a server. It also has nowhere to put an http.Client or
// a context.Context, which is how Decision 1 — no outbound reachability helper
// — is enforced by the signature rather than by a comment.
type Params struct {
	ListenPort   int
	TLSMode      string
	VoiceEnabled bool
	VoiceNodeIP  string
}

// LocalAddress is one address on one interface, with its reachability class.
type LocalAddress struct {
	Addr string `json:"addr"`
	Kind Kind   `json:"kind"`
}

// RequiredPort is one forwarding rule an owner has to create. Port is a string
// because the LiveKit media range is a range, not a number.
type RequiredPort struct {
	Port     string `json:"port"`
	Protocol string `json:"protocol"`
	Purpose  string `json:"purpose"`
}

// Unknown is one thing this server cannot determine about its own
// reachability, why it cannot, and the check the owner runs instead.
//
// This is the milestone's actual deliverable. A diagnostic that reports only
// what it can measure reads as a clean bill of health; the failures B6-6 is
// about — a blocked port, carrier NAT, a router that will not hairpin — are
// all invisible from in here, and saying so is the honest answer.
type Unknown struct {
	Fact       string `json:"fact"`
	Why        string `json:"why"`
	HowToCheck string `json:"how_to_check"`
}

// Report is the reachability picture from inside the server's own network.
type Report struct {
	ListenPort         int            `json:"listen_port"`
	BindsAllInterfaces bool           `json:"binds_all_interfaces"`
	LocalAddresses     []LocalAddress `json:"local_addresses"`
	HasGlobalAddress   bool           `json:"has_global_address"`
	CGNATRangePresent  bool           `json:"cgnat_range_present"`
	CGNATNote          string         `json:"cgnat_note,omitempty"`
	RequiredPorts      []RequiredPort `json:"required_ports"`
	VoiceNodeIP        string         `json:"voice_node_ip,omitempty"`
	VoiceNodeIPKind    Kind           `json:"voice_node_ip_kind,omitempty"`
	TLSMode            string         `json:"tls_mode"`

	// PublicIPHTTPSSupported is false in every build that ships today: B6-3
	// is deferred and loadACME rejects an IP for tls.domain. It is a field
	// rather than a constant string so the day a certificate flow exists,
	// the report changes with it instead of continuing to say "no".
	PublicIPHTTPSSupported bool   `json:"public_ip_https_supported"`
	PublicIPHTTPSReason    string `json:"public_ip_https_reason"`

	Undeterminable []Unknown `json:"undeterminable"`
}

// cgnatNote names both explanations for a 100.64.0.0/10 address, because
// nothing observable from this host tells them apart. Stating either one alone
// would be the confident wrong answer this milestone exists to prevent.
const cgnatNote = "An address in 100.64.0.0/10 is either a carrier-grade NAT (RFC6598) address " +
	"from your ISP, in which case inbound port forwarding cannot be made to work, or a Tailscale " +
	"tailnet address, in which case it is working as intended. This server cannot tell which from here."

// BuildReport classifies addrs and states what it cannot determine.
//
// It performs no network I/O at all: every input is already in hand. See the
// package comment for why there is no probe.
func BuildReport(addrs []netip.Addr, p Params) Report {
	r := Report{
		ListenPort: p.ListenPort,
		// The listener is built as ":port" (Server/internal/app/lifecycle.go),
		// never bound to one interface, so "listening on the wrong NIC" is
		// not a failure mode an owner has to rule out.
		BindsAllInterfaces:     true,
		TLSMode:                p.TLSMode,
		PublicIPHTTPSSupported: false,
		PublicIPHTTPSReason: "This build cannot obtain a certificate for a bare IP address: tls.mode " +
			"'acme' requires a hostname. Use a domain name, or a manually supplied certificate, or accept " +
			"the self-signed certificate on each client.",
	}

	for _, a := range addrs {
		k := Classify(a)
		r.LocalAddresses = append(r.LocalAddresses, LocalAddress{Addr: a.String(), Kind: k})
		switch k {
		case KindGlobal:
			r.HasGlobalAddress = true
		case KindCGNAT:
			r.CGNATRangePresent = true
		}
	}
	if r.CGNATRangePresent {
		r.CGNATNote = cgnatNote
	}

	r.RequiredPorts = requiredPorts(p)

	if p.VoiceNodeIP != "" {
		r.VoiceNodeIP = p.VoiceNodeIP
		if a, err := netip.ParseAddr(p.VoiceNodeIP); err == nil {
			r.VoiceNodeIPKind = Classify(a)
		} else {
			r.VoiceNodeIPKind = KindOther
		}
	}

	r.Undeterminable = undeterminable(p)
	return r
}

func requiredPorts(p Params) []RequiredPort {
	ports := []RequiredPort{
		{Port: fmt.Sprintf("%d", p.ListenPort), Protocol: "tcp", Purpose: "OwnCord HTTPS, REST API and WebSocket"},
	}
	if !p.VoiceEnabled {
		return ports
	}
	// Voice is where direct port forwarding actually fails: the media range
	// is UDP and no HTTP reverse proxy can carry it.
	return append(ports,
		RequiredPort{Port: "7880", Protocol: "tcp", Purpose: "LiveKit signalling"},
		RequiredPort{Port: "7881", Protocol: "tcp", Purpose: "LiveKit TCP media fallback"},
		RequiredPort{Port: "50000-60000", Protocol: "udp", Purpose: "LiveKit WebRTC media (ICE)"},
	)
}

// undeterminable is unconditional. It does not shrink when the topology looks
// healthy, because a topology looking healthy from in here is exactly the
// state in which an owner most needs to be told what was not checked.
func undeterminable(p Params) []Unknown {
	const selfCheck = "Test from a network that is not your own — a phone on mobile data works — " +
		"never from inside the LAN. See docs/port-forwarding.md."

	list := []Unknown{
		{
			Fact: fmt.Sprintf("Whether TCP port %d is reachable from the internet", p.ListenPort),
			Why: "Proving inbound reachability needs something outside your network to connect back in. " +
				"OwnCord contacts no such service by design (BPR-055), so it cannot answer this.",
			HowToCheck: selfCheck,
		},
		{
			Fact: "Whether your connection is behind carrier-grade NAT (CGNAT)",
			Why: "This host sees only its own addresses. Your router's WAN address, which is what would " +
				"reveal carrier NAT, is not visible from here.",
			HowToCheck: "Compare the WAN address on your router's status page with the address a " +
				"what-is-my-IP page reports. If they differ, or the router's WAN address is in " +
				"100.64.0.0/10, you are behind CGNAT and port forwarding cannot work — use " +
				"docs/tailscale.md instead.",
		},
		{
			Fact: "Whether your router supports hairpin NAT (NAT loopback)",
			Why: "Hairpinning is how your router handles a LAN client dialling your public address. " +
				"It is a property of the router, for an address this server does not know.",
			HowToCheck: "From a device on the same LAN, open your public address. If it fails while a " +
				"device on mobile data succeeds, your router does not hairpin: give LAN clients the " +
				"local address, or use split-horizon DNS.",
		},
		{
			Fact: "Whether your ISP blocks the ports you forwarded",
			Why:  "A blocked port looks identical to a missing forwarding rule from inside the network.",
			HowToCheck: "Residential lines commonly block inbound 80 and 443 while leaving 8443 open. " +
				"If a high port works and 443 does not, that is your ISP. " + selfCheck,
		},
		{
			Fact: "Whether your public IP address changes",
			Why:  "This server never learns its public address, so it cannot notice the address changing.",
			HowToCheck: "Most residential connections get a new address periodically. Use dynamic DNS " +
				"and share a hostname rather than an IP literal — see docs/port-forwarding.md.",
		},
	}

	if p.VoiceEnabled {
		list = append(list, Unknown{
			Fact: "Whether WebRTC media can actually flow on UDP 50000-60000",
			Why: "Joining a voice channel succeeds as soon as signalling works. Media travels on a " +
				"separate UDP range, so a missing forwarding rule there produces a call that connects " +
				"and then carries no audio.",
			HowToCheck: "Have someone outside your network join a voice channel. If they connect but " +
				"nobody hears anything, forward UDP 50000-60000 and set voice.node_ip to your public " +
				"address.",
		})
	}
	return list
}

// LocalAddrs returns every address on every interface of this host, as
// netip.Addr values ready for BuildReport.
//
// net.InterfaceAddrs reads the kernel's interface table. It is a syscall, not
// a packet: nothing is sent, nothing is resolved, and no third party learns
// this server exists. TestReport_MakesNoOutboundCall asserts that at runtime
// rather than trusting this comment.
//
// Errors are swallowed into an empty slice on purpose: an unreadable interface
// table means "unknown", and BuildReport's Undeterminable list already says
// the important things are unknown. Failing the diagnostics endpoint because
// the topology could not be read would be worse than reporting no addresses.
func LocalAddrs() []netip.Addr {
	ifaceAddrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	out := make([]netip.Addr, 0, len(ifaceAddrs))
	for _, a := range ifaceAddrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		addr, ok := netip.AddrFromSlice(ipNet.IP)
		if !ok {
			continue
		}
		// Drop the zone: a zoned address is scoped by definition, and the
		// zone name is host-specific noise in a report an owner reads.
		out = append(out, addr.Unmap().WithZone(""))
	}
	return out
}
