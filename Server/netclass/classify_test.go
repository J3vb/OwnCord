package netclass

import (
	"net/netip"
	"testing"
)

// TestClassify_NamesEveryKind names one address per Kind. It is the table that
// makes the CGNAT row impossible to delete silently: B6-6 exists because the
// classifier on the request path could not see 100.64.0.0/10, and a test that
// never mentions the range would let that regress unnoticed.
func TestClassify_NamesEveryKind(t *testing.T) {
	cases := []struct {
		name string
		addr string
		want Kind
	}{
		{"IPv4 loopback", "127.0.0.1", KindLoopback},
		{"IPv6 loopback", "::1", KindLoopback},
		{"RFC1918 10/8", "10.0.0.5", KindPrivate},
		{"RFC1918 172.16/12", "172.16.0.1", KindPrivate},
		{"RFC1918 172.31 upper edge", "172.31.255.255", KindPrivate},
		{"RFC1918 192.168/16", "192.168.1.50", KindPrivate},
		{"carrier-grade NAT (RFC6598)", "100.64.1.2", KindCGNAT},
		{"CGNAT upper edge", "100.127.255.255", KindCGNAT},
		{"IPv4 link-local (RFC3927)", "169.254.1.1", KindLinkLocal},
		{"IPv6 link-local (RFC4291)", "fe80::1", KindLinkLocal},
		{"IPv6 unique local (RFC4193)", "fd12::1", KindUniqueLocal},
		{"global IPv4", "8.8.8.8", KindGlobal},
		{"global IPv6", "2606:4700::1111", KindGlobal},
		{"unspecified", "0.0.0.0", KindOther},
		{"documentation TEST-NET-3", "203.0.113.1", KindOther},
		{"documentation IPv6", "2001:db8::1", KindOther},
		{"reserved 240/4", "240.0.0.1", KindOther},
		{"multicast", "224.0.0.1", KindOther},
		{"172.32 is not RFC1918", "172.32.0.1", KindGlobal},
		{"100.128 is above the CGNAT block", "100.128.0.1", KindGlobal},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			addr, err := netip.ParseAddr(tc.addr)
			if err != nil {
				t.Fatalf("ParseAddr(%q): %v", tc.addr, err)
			}
			if got := Classify(addr); got != tc.want {
				t.Errorf("Classify(%s) = %q, want %q", tc.addr, got, tc.want)
			}
		})
	}
}

// TestClassify_UnmapsIPv4Mapped pins the one mistake that would let every IPv4
// rule above be bypassed by respelling the address, the same way
// Server/safefetch/classify.go:96-99 does.
func TestClassify_UnmapsIPv4Mapped(t *testing.T) {
	cases := map[string]Kind{
		"::ffff:192.168.1.1": KindPrivate,
		"::ffff:100.64.1.2":  KindCGNAT,
		"::ffff:127.0.0.1":   KindLoopback,
		"::ffff:8.8.8.8":     KindGlobal,
	}
	for in, want := range cases {
		addr, err := netip.ParseAddr(in)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", in, err)
		}
		if got := Classify(addr); got != want {
			t.Errorf("Classify(%s) = %q, want %q — a mapped address must be judged as its IPv4 form", in, got, want)
		}
	}
}

// TestClassify_InvalidAddrIsOther keeps the zero value from reading as global.
func TestClassify_InvalidAddrIsOther(t *testing.T) {
	if got := Classify(netip.Addr{}); got != KindOther {
		t.Errorf("Classify(zero Addr) = %q, want %q", got, KindOther)
	}
}

// TestRank_OrdersByUsefulnessForReaching orders the kinds the way the startup
// banner must pick between them: a host with both a public address and a Docker
// bridge address has to print the public one.
func TestRank_OrdersByUsefulnessForReaching(t *testing.T) {
	order := []Kind{KindLoopback, KindOther, KindLinkLocal, KindCGNAT, KindUniqueLocal, KindPrivate, KindGlobal}
	for i := 1; i < len(order); i++ {
		if Rank(order[i-1]) >= Rank(order[i]) {
			t.Errorf("Rank(%q)=%d must be below Rank(%q)=%d",
				order[i-1], Rank(order[i-1]), order[i], Rank(order[i]))
		}
	}
}
