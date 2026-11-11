package netclass

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
)

// Params is everything BuildReport needs from the configuration. It has nowhere
// to put an http.Client or context, so the no-outbound-probe rule is enforced by the signature.
type Params struct {
	ListenPort   int
	TLSMode      string
	VoiceEnabled bool
	VoiceNodeIP  string
	// VoiceUDPPort, when non-zero, is the single LiveKit media port (voice.udp_port).
	VoiceUDPPort int
}

// LocalAddress is one address on one interface, with its reachability class.
type LocalAddress struct {
	Addr string `json:"addr"`
	Kind Kind   `json:"kind"`
}

// RequiredPort is one forwarding rule an owner has to create; Port is a string because it may be a range.
type RequiredPort struct {
	Port     string `json:"port"`
	Protocol string `json:"protocol"`
	Purpose  string `json:"purpose"`
}

// Unknown is one thing this server cannot determine about its reachability,
// why, and the check the owner runs instead. It is the report's real
// deliverable: the failures it is about (blocked port, carrier NAT, no
// hairpin) are invisible from inside, and a report of only what it can
// measure would read as a clean bill of health.
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

	// PublicIPHTTPSSupported is false in every shipped build: loadACME rejects an
	// IP for tls.domain.
	PublicIPHTTPSSupported bool   `json:"public_ip_https_supported"`
	PublicIPHTTPSReason    string `json:"public_ip_https_reason"`

	Undeterminable []Unknown `json:"undeterminable"`
}

// cgnatNote names both explanations for a 100.64.0.0/10 address;
// either alone would be a confident wrong answer.
const cgnatNote = "An address in 100.64.0.0/10 is either a carrier-grade NAT (RFC6598) address " +
	"from your ISP, in which case inbound port forwarding cannot be made to work, or a Tailscale " +
	"tailnet address, in which case it is working as intended. This server cannot tell which from here."

// BuildReport classifies addrs and states what it cannot determine; it performs no network I/O.
func BuildReport(addrs []netip.Addr, p Params) Report {
	r := Report{
		ListenPort: p.ListenPort,
		// The listener is built as ":port" (internal/app/lifecycle.go), never one interface.
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
		default:
			// Other classes set no summary flag; the two flags answer only
			// "directly on the internet" and "is 100.64/10 in play".
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
	// Capacity 3: the chat port plus LiveKit's two.
	ports := make([]RequiredPort, 0, 3)
	ports = append(ports,
		RequiredPort{Port: strconv.Itoa(p.ListenPort), Protocol: "tcp", Purpose: "OwnCord HTTPS, REST API and WebSocket"},
	)
	if !p.VoiceEnabled {
		return ports
	}
	// LiveKit's API port (7880) is deliberately absent: clients tunnel signalling
	// through /livekit on the chat port, so forwarding it only exposes the API.
	// voice.udp_port switches media to one UDP port; report that, not the range.
	return append(ports,
		RequiredPort{Port: "7881", Protocol: "tcp", Purpose: "LiveKit TCP media fallback"},
		RequiredPort{Port: VoiceUDPLabel(p.VoiceUDPPort), Protocol: "udp", Purpose: "LiveKit WebRTC media (ICE)"},
	)
}

// VoiceUDPLabel is the UDP media port spec LiveKit needs forwarded: the single
// voice.udp_port when set, the 50000-60000 range otherwise.
func VoiceUDPLabel(port int) string {
	if port > 0 {
		return strconv.Itoa(port)
	}
	return "50000-60000"
}

// undeterminable is unconditional: it does not shrink when the topology looks
// healthy, when an owner most needs to be told what was not checked.
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
				"and share a hostname rather than an IP literal. Leave voice.node_ip empty so LiveKit " +
				"detects the address when it starts, and restart the server after the address changes " +
				"— see docs/port-forwarding.md.",
		},
	}

	if p.VoiceEnabled {
		// Name the port(s) the operator actually forwarded.
		ports := "UDP " + VoiceUDPLabel(p.VoiceUDPPort)
		list = append(list, Unknown{
			Fact: "Whether WebRTC media can actually flow on " + ports,
			Why: "Joining a voice channel succeeds as soon as signalling works. Media travels on a " +
				"separate UDP port, so a missing forwarding rule there produces a call that connects " +
				"and then carries no audio.",
			HowToCheck: "Have someone outside your network join a voice channel. If they connect but " +
				"nobody hears anything, forward " + ports + " and leave voice.node_ip empty so LiveKit " +
				"detects your public address (or set it to that address).",
		})
	}
	return list
}

// LocalAddrs returns every address on every interface, ready for BuildReport;
// it sends and resolves nothing. Errors become an empty slice on purpose: an
// unreadable table means "unknown", which the Undeterminable list already says.
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
		// Drop the zone: host-specific noise in an owner's report.
		out = append(out, addr.Unmap().WithZone(""))
	}
	return out
}
