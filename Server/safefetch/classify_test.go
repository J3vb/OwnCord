package safefetch

import (
	"net/netip"
	"strings"
	"testing"
)

// Every address class the C-09 policy calls non-global must be refused, by
// name, so a later edit that drops one prefix fails here rather than in
// production. The ranges below the "extends ipAllowed" line are the ones
// Server/plugin/host_http.go's classifier missed before B5-1.
func TestClassifyAddr_RejectsEveryNonGlobalClass(t *testing.T) {
	cases := []struct{ addr, why string }{
		// What plugin/host_http.go's ipAllowed already rejected.
		{"127.0.0.1", "loopback"},
		{"127.255.255.254", "loopback range"},
		{"10.0.0.1", "RFC1918"},
		{"172.16.5.5", "RFC1918"},
		{"172.31.255.255", "RFC1918 high"},
		{"192.168.1.1", "RFC1918"},
		{"169.254.169.254", "link-local / cloud metadata"},
		{"100.64.5.5", "RFC6598 carrier-grade NAT"},
		{"100.127.255.255", "RFC6598 high"},
		{"0.0.0.0", "unspecified"},
		{"224.0.0.1", "multicast"},
		{"::1", "IPv6 loopback"},
		{"::", "IPv6 unspecified"},
		{"fc00::1", "RFC4193 unique local"},
		{"fd12:3456:789a::1", "RFC4193 unique local"},
		{"fe80::1", "IPv6 link-local"},
		{"ff02::1", "IPv6 multicast"},

		// What B5-1 adds — the whole reason this package exists.
		{"192.0.2.1", "RFC5737 TEST-NET-1 documentation"},
		{"198.51.100.1", "RFC5737 TEST-NET-2 documentation"},
		{"203.0.113.5", "RFC5737 TEST-NET-3 documentation"},
		{"2001:db8::1", "RFC3849 IPv6 documentation"},
		{"3fff::1", "RFC9637 IPv6 documentation"},
		{"198.18.0.1", "RFC2544 benchmarking"},
		{"198.19.255.255", "RFC2544 benchmarking high"},
		{"2001:2::1", "RFC5180 IPv6 benchmarking"},
		{"0.1.2.3", "RFC1122 this-network"},
		{"192.0.0.1", "RFC6890 IETF protocol assignments"},
		{"192.0.0.170", "RFC7050 NAT64 discovery"},
		{"192.88.99.1", "RFC7526 deprecated 6to4 relay anycast"},
		{"240.0.0.1", "RFC1112 reserved"},
		{"255.255.255.255", "limited broadcast"},
		{"2002::1", "RFC3056 6to4"},
		{"2001::1", "RFC4380 Teredo"},
		{"2001:20::1", "RFC7343 ORCHIDv2"},
		{"64:ff9b:1::1", "RFC8215 local-use IPv4/IPv6 translation"},
		{"100::1", "RFC6666 discard-only"},
		{"5f00::1", "RFC9602 SRv6 segment routing"},

		// IPv4-mapped IPv6 must normalise before classification, or every
		// v4 rule above is bypassable by spelling the address as v6.
		{"::ffff:127.0.0.1", "IPv4-mapped loopback"},
		{"::ffff:169.254.169.254", "IPv4-mapped link-local"},
		{"::ffff:10.0.0.1", "IPv4-mapped RFC1918"},
		{"::ffff:192.0.2.1", "IPv4-mapped documentation"},
	}
	for _, c := range cases {
		addr, err := netip.ParseAddr(c.addr)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", c.addr, err)
		}
		if err := ClassifyAddr(addr); err == nil {
			t.Errorf("ClassifyAddr(%s) allowed a %s address", c.addr, c.why)
		}
	}
}

func TestClassifyAddr_AllowsGloballyRoutable(t *testing.T) {
	for _, s := range []string{
		"8.8.8.8",
		"1.1.1.1",
		"93.184.216.34",
		"2606:4700:4700::1111",
		"2a00:1450:4001:800::200e",
	} {
		addr, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", s, err)
		}
		if err := ClassifyAddr(addr); err != nil {
			t.Errorf("ClassifyAddr(%s) refused a public address: %v", s, err)
		}
	}
}

// The zero Addr is what a failed parse yields; it must never be treated as
// routable, and it must not panic.
func TestClassifyAddr_RejectsZeroValue(t *testing.T) {
	if err := ClassifyAddr(netip.Addr{}); err == nil {
		t.Fatal("the zero netip.Addr must be refused")
	}
}

// A refusal names the address class so an operator reading a log can tell a
// blocked destination from a DNS failure.
func TestClassifyAddr_ErrorIsBlockedAddress(t *testing.T) {
	err := ClassifyAddr(netip.MustParseAddr("169.254.169.254"))
	if err == nil {
		t.Fatal("want a refusal")
	}
	if !strings.Contains(err.Error(), "169.254.169.254") {
		t.Errorf("refusal should name the address, got %q", err)
	}
}

// A zone only ever names a scoped, non-global interface, and Unmap does not
// clear it for a non-mapped address. Without this the check is deletable with
// the suite green, which is how it was found.
func TestClassifyAddr_RejectsZonedAddresses(t *testing.T) {
	for _, s := range []string{"2606:4700:4700::1111%eth0", "fe80::1%eth0", "::1%lo"} {
		addr, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", s, err)
		}
		if err := ClassifyAddr(addr); err == nil {
			t.Errorf("ClassifyAddr(%s) allowed a zoned address", s)
		}
	}
}

// RFC 6052's well-known prefix wraps an IPv4 address that a NAT64 translator
// unwraps and delivers, so the embedded address is the one that decides. On
// an IPv6-only host with NAT64/DNS64 — the default on IPv6-only cloud subnets
// — 64:ff9b::a9fe:a9fe reaches 169.254.169.254 and the cloud metadata service
// with it.
func TestClassifyAddr_UnwrapsNAT64(t *testing.T) {
	blocked := map[string]string{
		"64:ff9b::7f00:1":    "127.0.0.1",
		"64:ff9b::a00:5":     "10.0.0.5",
		"64:ff9b::a9fe:a9fe": "169.254.169.254 (cloud metadata)",
		"64:ff9b::c0a8:1":    "192.168.0.1",
		"64:ff9b::c000:201":  "192.0.2.1 (documentation)",
		"64:ff9b::6440:1":    "100.64.0.1 (carrier-grade NAT)",
	}
	for addr, why := range blocked {
		if err := ClassifyAddr(netip.MustParseAddr(addr)); err == nil {
			t.Errorf("ClassifyAddr(%s) allowed a NAT64 wrapper around %s", addr, why)
		}
	}
	// A NAT64 wrapper around a routable address is how an IPv6-only server
	// reaches an IPv4-only upstream; refusing the prefix outright would cut
	// that off, so it has to be unwrapped rather than blocked.
	for _, addr := range []string{"64:ff9b::808:808", "64:ff9b::5db8:d822"} {
		if err := ClassifyAddr(netip.MustParseAddr(addr)); err != nil {
			t.Errorf("ClassifyAddr(%s) refused a NAT64 wrapper around a public address: %v", addr, err)
		}
	}
}

// Two more non-global classes that neither the IANA special-purpose registry
// rows nor Go's own predicates cover: deprecated IPv6 site-local, and the
// deprecated IPv4-compatible form, which is another IPv4 address in disguise.
func TestClassifyAddr_RejectsDeprecatedScopedForms(t *testing.T) {
	for _, s := range []string{"fec0::1", "feff::1", "::7f00:1", "::a00:5", "::c0a8:1"} {
		if err := ClassifyAddr(netip.MustParseAddr(s)); err == nil {
			t.Errorf("ClassifyAddr(%s) allowed a deprecated non-global form", s)
		}
	}
}
