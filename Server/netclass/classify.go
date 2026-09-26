// Package netclass classifies IP addresses by how far they can be reached
// from, and reports what a server can and cannot determine about its own
// reachability from inside its own network (B6-6).
//
// It opens no socket and resolves no name. That is a decision, not an
// oversight: proving inbound reachability needs a helper outside the NAT, and
// this repository already removed a probe that merely looked like one
// (Server/internal/app/banner.go:98-100) because BPR-055's proof must not
// contain an outbound connect at every start. TestReport_MakesNoOutboundCall
// and TestNetclassImportsNoNetworkClient pin the absence.
package netclass

import "net/netip"

// Kind is how reachable an address is, from whose point of view.
//
// It is deliberately finer-grained than net/netip's own predicates, which
// cannot express the two distinctions B6-6 turns on: netip.Addr.IsPrivate
// reports false for 100.64.0.0/10 (carrier-grade NAT), and it reports true for
// both RFC1918 and IPv6 unique-local, which need separate names because a
// reader has to know which one they are looking at.
type Kind string

const (
	KindLoopback    Kind = "loopback"
	KindPrivate     Kind = "private"
	KindCGNAT       Kind = "cgnat"
	KindLinkLocal   Kind = "link_local"
	KindUniqueLocal Kind = "unique_local"
	KindGlobal      Kind = "global"
	// KindOther is every remaining non-global block — unspecified,
	// multicast, documentation, benchmarking, reserved. They are grouped
	// because no operator decision turns on telling them apart; what matters
	// is that none of them is a usable connect address.
	KindOther Kind = "other"
)

// cgnat is RFC 6598's shared address space. It gets its own constant because
// it is the range this milestone exists for and the one net/netip will not
// name: a 100.x address is either a carrier-NAT WAN address or Tailscale, and
// nothing observable from this host distinguishes the two.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// uniqueLocal is RFC 4193 fc00::/7.
var uniqueLocal = netip.MustParsePrefix("fc00::/7")

// rfc1918 is the IPv4 private set. netip.Addr.IsPrivate covers exactly these
// three plus fc00::/7; they are listed explicitly so IPv4-private and
// IPv6-unique-local can be reported under different names.
var rfc1918 = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
}

// nonGlobal is every remaining special-purpose block that netip's predicates
// do not catch, mirroring the vocabulary of Server/safefetch/classify.go
// without importing its verdict: that function answers "may this server dial
// it", refuses the documentation ranges, and is an SSRF policy rather than a
// topology report. Reusing it here would silently reclassify 203.0.113.1.
var nonGlobal = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),       // this-network (RFC1122)
	netip.MustParsePrefix("192.0.0.0/24"),    // IETF protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),    // documentation TEST-NET-1
	netip.MustParsePrefix("192.88.99.0/24"),  // deprecated 6to4 relay anycast
	netip.MustParsePrefix("198.18.0.0/15"),   // benchmarking (RFC2544)
	netip.MustParsePrefix("198.51.100.0/24"), // documentation TEST-NET-2
	netip.MustParsePrefix("203.0.113.0/24"),  // documentation TEST-NET-3
	netip.MustParsePrefix("240.0.0.0/4"),     // reserved (RFC1112)
	netip.MustParsePrefix("64:ff9b:1::/48"),  // local-use IPv4/IPv6 translation
	netip.MustParsePrefix("100::/64"),        // discard-only (RFC6666)
	netip.MustParsePrefix("2001::/23"),       // IETF protocol assignments
	netip.MustParsePrefix("2001:20::/28"),    // ORCHIDv2 (RFC7343)
	netip.MustParsePrefix("2001:db8::/32"),   // documentation (RFC3849)
	netip.MustParsePrefix("2002::/16"),       // 6to4 (RFC3056)
	netip.MustParsePrefix("3fff::/20"),       // documentation (RFC9637)
	netip.MustParsePrefix("5f00::/16"),       // SRv6 segment routing (RFC9602)
	netip.MustParsePrefix("fec0::/10"),       // deprecated site-local (RFC3879)
}

// Classify names the reachability class of addr.
//
// It unmaps first. ::ffff:100.64.1.2 is 100.64.1.2 on the wire, so judging it
// as an IPv6 address would let every IPv4 rule below be bypassed by respelling
// the address.
func Classify(addr netip.Addr) Kind {
	if !addr.IsValid() {
		return KindOther
	}
	a := addr.Unmap()

	switch {
	case a.IsLoopback():
		return KindLoopback
	case a.IsUnspecified(), a.IsMulticast(), a.IsInterfaceLocalMulticast(), a.IsLinkLocalMulticast():
		return KindOther
	case a.IsLinkLocalUnicast():
		return KindLinkLocal
	case cgnat.Contains(a):
		return KindCGNAT
	}
	for _, p := range rfc1918 {
		if p.Contains(a) {
			return KindPrivate
		}
	}
	if uniqueLocal.Contains(a) {
		return KindUniqueLocal
	}
	for _, p := range nonGlobal {
		if p.Contains(a) {
			return KindOther
		}
	}
	if a.IsGlobalUnicast() {
		return KindGlobal
	}
	return KindOther
}

// Rank orders kinds by how widely an address of that kind can be reached, so a
// caller choosing one address out of an interface table picks the most useful.
//
// This is the fix for the startup banner: it took the first address that
// satisfied net.IP.IsGlobalUnicast, which is true for RFC1918, so a host with
// both a public address and a Docker bridge could print the bridge.
func Rank(k Kind) int {
	switch k {
	case KindGlobal:
		return 6
	case KindPrivate:
		return 5
	case KindUniqueLocal:
		return 4
	case KindCGNAT:
		return 3
	case KindLinkLocal:
		return 2
	case KindOther:
		return 1
	default: // KindLoopback
		return 0
	}
}
