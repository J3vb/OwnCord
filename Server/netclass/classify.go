// Package netclass classifies IP addresses by reachability and reports what a
// server cannot determine about its own reachability from inside its network.
//
// It opens no socket and resolves no name: a report must not make an outbound
// connect at every start, and proving inbound reachability needs a helper
// outside the NAT.
package netclass

import "net/netip"

// Kind is how reachable an address is. It is finer-grained than netip's
// predicates: IsPrivate is false for CGNAT and true for both RFC1918 and IPv6 unique-local.
type Kind string

const (
	KindLoopback    Kind = "loopback"
	KindPrivate     Kind = "private"
	KindCGNAT       Kind = "cgnat"
	KindLinkLocal   Kind = "link_local"
	KindUniqueLocal Kind = "unique_local"
	KindGlobal      Kind = "global"
	// KindOther is every remaining non-global block, grouped because no operator
	// decision turns on telling them apart.
	KindOther Kind = "other"
)

// cgnat is RFC 6598's shared address space: a 100.x address is either a
// carrier-NAT WAN address or Tailscale, and this host cannot tell which.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// uniqueLocal is RFC 4193 fc00::/7.
var uniqueLocal = netip.MustParsePrefix("fc00::/7")

// rfc1918 is listed explicitly so IPv4-private and IPv6-unique-local report under different names.
var rfc1918 = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
}

// nonGlobal is every special-purpose block netip's predicates miss. It does not
// reuse safefetch's verdict, an SSRF policy that would reclassify 203.0.113.1.
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

// Classify names the reachability class of addr, unmapping first so
// ::ffff:100.64.1.2 cannot bypass the IPv4 rules by respelling.
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

// Rank orders kinds by how widely reachable they are, so picking one address
// from an interface table prefers a public one over a Docker bridge.
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
