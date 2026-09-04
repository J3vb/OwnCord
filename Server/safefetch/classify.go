package safefetch

import (
	"fmt"
	"net/netip"
)

// blockedPrefix is one non-global address range and the reason it is refused.
// The reason reaches the caller's error, so a refusal reads as a policy
// decision rather than an anonymous failure.
type blockedPrefix struct {
	prefix netip.Prefix
	why    string
}

// blockedPrefixes is the whole non-global set: everything
// Server/plugin/host_http.go's ipAllowed refused before B5-1, plus the
// documentation, benchmarking and remaining reserved blocks it missed
// (docs/trust-model.md, "Desktop preview destination policy (C-09)", clause 3).
//
// It is a denylist of the IANA special-purpose address registries rather than
// an allowlist of global unicast, because a new global allocation must not
// need a code change here to become reachable. Adding a range is a one-line
// edit; TestClassifyAddr_RejectsEveryNonGlobalClass names every one of them so
// a deletion fails loudly.
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

	// IPv6. IPv4-mapped addresses never reach this table: classify unmaps
	// first, so ::ffff:10.0.0.1 is judged as 10.0.0.1 by the IPv4 rows above.
	{netip.MustParsePrefix("::/128"), "unspecified"},
	{netip.MustParsePrefix("::1/128"), "loopback"},
	{netip.MustParsePrefix("64:ff9b:1::/48"), "local-use IPv4/IPv6 translation (RFC8215)"},
	{netip.MustParsePrefix("100::/64"), "discard-only (RFC6666)"},
	{netip.MustParsePrefix("2001::/23"), "IETF protocol assignments, including Teredo and IPv6 benchmarking (RFC2928)"},
	{netip.MustParsePrefix("2001:20::/28"), "ORCHIDv2 (RFC7343)"},
	{netip.MustParsePrefix("2001:db8::/32"), "documentation (RFC3849)"},
	{netip.MustParsePrefix("2002::/16"), "6to4 (RFC3056)"},
	{netip.MustParsePrefix("3fff::/20"), "documentation (RFC9637)"},
	{netip.MustParsePrefix("5f00::/16"), "SRv6 segment routing (RFC9602)"},
	{netip.MustParsePrefix("fc00::/7"), "unique local (RFC4193)"},
	{netip.MustParsePrefix("fe80::/10"), "link-local (RFC4291)"},
	{netip.MustParsePrefix("ff00::/8"), "multicast (RFC4291)"},
}

// ClassifyAddr reports nil when addr is a globally routable unicast address
// this server may dial, and a wrapped ErrBlockedAddress otherwise.
//
// It is exported so a call site can compose it — a Policy.Classify that wraps
// it to widen or narrow the set is the seam B7's broker and this package's own
// tests use. Production policies in this repository leave Policy.Classify nil,
// which selects exactly this function; TestNoProductionOverrideOfClassify
// keeps it that way.
func ClassifyAddr(addr netip.Addr) error {
	if !addr.IsValid() {
		return fmt.Errorf("%w: not an IP address", ErrBlockedAddress)
	}
	// Unmap before anything else. ::ffff:127.0.0.1 is 127.0.0.1 on the wire,
	// so classifying it as an IPv6 address would let every IPv4 rule below be
	// bypassed by respelling the address.
	a := addr.Unmap()
	if a.Zone() != "" {
		return fmt.Errorf("%w: %s carries a zone, which only scoped (non-global) addresses do", ErrBlockedAddress, addr)
	}
	for _, b := range blockedPrefixes {
		if b.prefix.Contains(a) {
			return fmt.Errorf("%w: %s is %s", ErrBlockedAddress, a, b.why)
		}
	}
	// Belt and braces for anything the table above has not caught yet: the
	// stdlib predicates cover the same classes from a different angle, so a
	// range added to IANA's registry before it is added here still fails.
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
