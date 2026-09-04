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
