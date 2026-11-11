package safefetch

import (
	"fmt"
	"net/netip"
)

// blockedPrefix is one non-global address range and the reason reported in the error.
type blockedPrefix struct {
	prefix netip.Prefix
	why    string
}

// blockedPrefixes is the non-global set (docs/trust-model.md clause 3): a
// denylist of the IANA special-purpose registries, so a new global allocation
// needs no code change to become reachable.
var blockedPrefixes = []blockedPrefix{
	// IPv4 — RFC 6890 and the registries it points at.
	{netip.MustParsePrefix("0.0.0.0/8"), "this-network (RFC1122)"},
	{netip.MustParsePrefix("10.0.0.0/8"), "private (RFC1918)"},
	{netip.MustParsePrefix("100.64.0.0/10"), "carrier-grade NAT (RFC6598)"},
	{netip.MustParsePrefix("127.0.0.0/8"), "loopback"},
	{netip.MustParsePrefix("169.254.0.0/16"), "link-local (RFC3927)"},
	{netip.MustParsePrefix("172.16.0.0/12"), "private (RFC1918)"},
	{netip.MustParsePrefix("192.0.0.0/24"), "IETF protocol assignments (RFC6890)"},
	{netip.MustParsePrefix("192.0.2.0/24"), "documentation TEST-NET-1 (RFC5737)"},
	{netip.MustParsePrefix("192.88.99.0/24"), "deprecated 6to4 relay anycast (RFC7526)"},
	{netip.MustParsePrefix("192.168.0.0/16"), "private (RFC1918)"},
	{netip.MustParsePrefix("198.18.0.0/15"), "benchmarking (RFC2544)"},
	{netip.MustParsePrefix("198.51.100.0/24"), "documentation TEST-NET-2 (RFC5737)"},
	{netip.MustParsePrefix("203.0.113.0/24"), "documentation TEST-NET-3 (RFC5737)"},
	{netip.MustParsePrefix("224.0.0.0/4"), "multicast (RFC5771)"},
	{netip.MustParsePrefix("240.0.0.0/4"), "reserved (RFC1112), including the limited broadcast address"},

	// IPv6. IPv4-mapped addresses never reach this table; they are unmapped first.
	{netip.MustParsePrefix("::/128"), "unspecified"},
	{netip.MustParsePrefix("::1/128"), "loopback"},
	{netip.MustParsePrefix("64:ff9b:1::/48"), "local-use IPv4/IPv6 translation (RFC8215)"},
	{netip.MustParsePrefix("100::/64"), "discard-only (RFC6666)"},
	{netip.MustParsePrefix("2001::/23"), "IETF protocol assignments, including Teredo and IPv6 benchmarking (RFC2928)"},
	{netip.MustParsePrefix("2001:20::/28"), "ORCHIDv2 (RFC7343)"},
	{netip.MustParsePrefix("fec0::/10"), "deprecated site-local (RFC3879)"},
	// ::/96 is the deprecated IPv4-compatible form, an IPv4 address in disguise
	// that Unmap does not normalise. Listed before the rows it contains so its reason is the one reported.
	{netip.MustParsePrefix("::/96"), "deprecated IPv4-compatible (RFC4291)"},
	{netip.MustParsePrefix("2001:db8::/32"), "documentation (RFC3849)"},
	{netip.MustParsePrefix("2002::/16"), "6to4 (RFC3056)"},
	{netip.MustParsePrefix("3fff::/20"), "documentation (RFC9637)"},
	{netip.MustParsePrefix("5f00::/16"), "SRv6 segment routing (RFC9602)"},
	{netip.MustParsePrefix("fc00::/7"), "unique local (RFC4193)"},
	{netip.MustParsePrefix("fe80::/10"), "link-local (RFC4291)"},
	{netip.MustParsePrefix("ff00::/8"), "multicast (RFC4291)"},
}

// nat64WellKnown is RFC 6052's well-known prefix. A NAT64 translator delivers
// to the IPv4 address in the low 32 bits, so that is the address to judge:
// blocking the prefix cuts IPv6-only servers off from IPv4 upstreams, while
// allowing it would reach 169.254.169.254 as 64:ff9b::a9fe:a9fe.
//
// Known limit: an operator-chosen network-specific prefix (RFC 6052 §2.2) looks
// like any global address and is invisible here.
var nat64WellKnown = netip.MustParsePrefix("64:ff9b::/96")

// ClassifyAddr reports nil when addr is a globally routable unicast address,
// and a wrapped ErrBlockedAddress otherwise. Production policies leave
// Policy.Classify nil, which selects this function.
func ClassifyAddr(addr netip.Addr) error {
	if !addr.IsValid() {
		return fmt.Errorf("%w: not an IP address", ErrBlockedAddress)
	}
	// Unmap first: ::ffff:127.0.0.1 is 127.0.0.1 on the wire, and judging it as
	// IPv6 would bypass every IPv4 rule.
	a := addr.Unmap()
	if a.Zone() != "" {
		return fmt.Errorf("%w: %s carries a zone, which only scoped (non-global) addresses do", ErrBlockedAddress, addr)
	}
	if nat64WellKnown.Contains(a) {
		v4 := a.As16()
		embedded := netip.AddrFrom4([4]byte(v4[12:16]))
		if err := ClassifyAddr(embedded); err != nil {
			return fmt.Errorf("%w (reached through the NAT64 address %s)", err, a)
		}
		return nil
	}
	for _, b := range blockedPrefixes {
		if b.prefix.Contains(a) {
			return fmt.Errorf("%w: %s is %s", ErrBlockedAddress, a, b.why)
		}
	}
	// Belt and braces: stdlib predicates catch ranges IANA adds before this table does.
	switch {
	case a.IsLoopback():
		return fmt.Errorf("%w: %s is loopback", ErrBlockedAddress, a)
	case a.IsUnspecified():
		return fmt.Errorf("%w: %s is unspecified", ErrBlockedAddress, a)
	case a.IsMulticast():
		return fmt.Errorf("%w: %s is multicast", ErrBlockedAddress, a)
	case a.IsInterfaceLocalMulticast():
		return fmt.Errorf("%w: %s is interface-local multicast", ErrBlockedAddress, a)
	case a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast():
		return fmt.Errorf("%w: %s is link-local", ErrBlockedAddress, a)
	case a.IsPrivate():
		return fmt.Errorf("%w: %s is private", ErrBlockedAddress, a)
	case !a.IsGlobalUnicast():
		return fmt.Errorf("%w: %s is not global unicast", ErrBlockedAddress, a)
	}
	return nil
}
