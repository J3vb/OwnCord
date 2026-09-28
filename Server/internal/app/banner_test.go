package app

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/netclass"
)

// The banner's URLs must stay valid on an IPv6-only host: the address is
// bracketed before the port (a Codex finding on #1510).
func TestWSURL_BracketsIPv6(t *testing.T) {
	cases := []struct{ scheme, ip, want string }{
		{"http", "192.0.2.10", "ws://192.0.2.10:8080"},
		{"https", "2001:db8::1", "wss://[2001:db8::1]:8080"},
		{"https", "localhost", "wss://localhost:8080"},
	}
	for _, tc := range cases {
		if got := wsURL(tc.scheme, tc.ip, 8080); got != tc.want {
			t.Errorf("wsURL(%s, %s) = %q, want %q", tc.scheme, tc.ip, got, tc.want)
		}
	}
}

// ─── B6-6: the banner must not present a LAN address as "reachable" ─────────

func mustAddrs(t *testing.T, ss ...string) []netip.Addr {
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

// TestPickBannerAddr_PrefersPublicOverPrivate is the central B6-6 row.
//
// getOutboundIP took the first address satisfying net.IP.IsGlobalUnicast, and
// that predicate is true for RFC1918 — so a host with both a public address
// and a Docker bridge could print the bridge, and a home server always printed
// its LAN address as "an address this machine can be reached at".
func TestPickBannerAddr_PrefersPublicOverPrivate(t *testing.T) {
	cases := []struct {
		name     string
		addrs    []string
		wantAddr string
		wantKind netclass.Kind
	}{
		{
			name:     "public beats a Docker bridge listed first",
			addrs:    []string{"172.17.0.1", "93.184.216.34"},
			wantAddr: "93.184.216.34",
			wantKind: netclass.KindGlobal,
		},
		{
			name:     "public beats loopback and LAN",
			addrs:    []string{"127.0.0.1", "192.168.1.50", "93.184.216.34"},
			wantAddr: "93.184.216.34",
			wantKind: netclass.KindGlobal,
		},
		{
			name:     "LAN beats CGNAT and loopback when there is no public address",
			addrs:    []string{"127.0.0.1", "100.64.1.2", "192.168.1.50"},
			wantAddr: "192.168.1.50",
			wantKind: netclass.KindPrivate,
		},
		{
			name:     "IPv4 wins over IPv6 at the same rank",
			addrs:    []string{"2606:4700::1111", "93.184.216.34"},
			wantAddr: "93.184.216.34",
			wantKind: netclass.KindGlobal,
		},
		{
			name:     "IPv6 is used when it is all there is",
			addrs:    []string{"::1", "2606:4700::1111"},
			wantAddr: "2606:4700::1111",
			wantKind: netclass.KindGlobal,
		},
		{
			name:     "loopback only",
			addrs:    []string{"127.0.0.1"},
			wantAddr: "127.0.0.1",
			wantKind: netclass.KindLoopback,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, kind := pickBannerAddr(mustAddrs(t, tc.addrs...))
			if got != tc.wantAddr {
				t.Errorf("pickBannerAddr(%v) = %q, want %q", tc.addrs, got, tc.wantAddr)
			}
			if kind != tc.wantKind {
				t.Errorf("kind = %q, want %q", kind, tc.wantKind)
			}
		})
	}
}

// ─── O1: the banner must offer an admin URL the allowlist actually admits ──

// TestPickBannerLANAddr_ReturnsPrivateOrUniqueLocalOnly — the printed admin
// URL follows the most widely reachable address, so on a dual-stack host it
// can be a global IPv6. The default admin_allowed_cidrs admits only private
// and unique-local addresses, so that URL answers 403 even from the host.
// pickBannerLANAddr finds the address that does pass the perimeter.
func TestPickBannerLANAddr_ReturnsPrivateOrUniqueLocalOnly(t *testing.T) {
	cases := []struct {
		name  string
		addrs []string
		want  string
	}{
		{
			name:  "LAN IPv4 behind a global IPv6",
			addrs: []string{"2a02:1234::1", "192.168.1.50"},
			want:  "192.168.1.50",
		},
		{
			name:  "private outranks unique-local",
			addrs: []string{"fd12::1", "10.0.0.5"},
			want:  "10.0.0.5",
		},
		{
			name:  "no LAN address at all",
			addrs: []string{"2a02:1234::1", "93.184.216.34"},
			want:  "",
		},
		{
			name:  "loopback is not a LAN address to advertise",
			addrs: []string{"127.0.0.1", "::1"},
			want:  "",
		},
		{
			name:  "empty table",
			addrs: nil,
			want:  "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pickBannerLANAddr(mustAddrs(t, tc.addrs...))
			if got != tc.want {
				t.Errorf("pickBannerLANAddr(%v) = %q, want %q", tc.addrs, got, tc.want)
			}
		})
	}
}

// TestBannerLANAdminLine_OnlyWhenItDiffers — the extra line is noise when the
// primary admin URL already is the LAN address; it exists only to rescue the
// case where the printed address is outside the allowlist.
func TestBannerLANAdminLine_OnlyWhenItDiffers(t *testing.T) {
	if got := bannerLANAdminLine("https", "192.168.1.50", "192.168.1.50", 8443); got != "" {
		t.Errorf("line for a primary==LAN address = %q, want empty", got)
	}
	got := bannerLANAdminLine("https", "192.168.1.50", "2a02:1234::1", 8443)
	for _, want := range []string{"Admin (LAN)", "https://192.168.1.50:8443/admin"} {
		if !strings.Contains(got, want) {
			t.Errorf("line %q does not mention %q", got, want)
		}
	}
	if got := bannerLANAdminLine("https", "", "2a02:1234::1", 8443); got != "" {
		t.Errorf("line with no LAN address = %q, want empty", got)
	}
}

// TestPickBannerAddr_EmptyFallsBackToLocalhost keeps the old behaviour for a
// host with no readable interface table.
func TestPickBannerAddr_EmptyFallsBackToLocalhost(t *testing.T) {
	got, kind := pickBannerAddr(nil)
	if got != "localhost" {
		t.Errorf("pickBannerAddr(nil) = %q, want \"localhost\"", got)
	}
	if kind != netclass.KindLoopback {
		t.Errorf("kind = %q, want %q", kind, netclass.KindLoopback)
	}
}

// TestBannerQualifierNamesLANOnlyForPrivateAddress — printing the address is
// the easy half. Saying what kind of address it is, is the milestone.
func TestBannerQualifierNamesLANOnlyForPrivateAddress(t *testing.T) {
	got := bannerQualifier(netclass.KindPrivate, "192.168.1.50", 8443)

	for _, want := range []string{"LAN", "port-forwarding.md"} {
		if !strings.Contains(got, want) {
			t.Errorf("qualifier for a private address does not mention %q: %q", want, got)
		}
	}
}

// TestBannerQualifierNamesBothCGNATExplanations — a 100.x address is either
// carrier NAT or Tailscale and this host cannot tell which, so the banner must
// not pick one.
func TestBannerQualifierNamesBothCGNATExplanations(t *testing.T) {
	got := strings.ToLower(bannerQualifier(netclass.KindCGNAT, "100.64.1.2", 8443))

	for _, want := range []string{"carrier", "tailscale"} {
		if !strings.Contains(got, want) {
			t.Errorf("CGNAT qualifier does not mention %q: %q", want, got)
		}
	}
}

// TestBannerQualifier_PublicAddressStillDisclaimsVerification — the one case
// that looks like success. A public address on the host does not mean anything
// can reach it, and the banner must not imply that it does.
func TestBannerQualifier_PublicAddressStillDisclaimsVerification(t *testing.T) {
	got := strings.ToLower(bannerQualifier(netclass.KindGlobal, "93.184.216.34", 8443))

	if !strings.Contains(got, "cannot verify") {
		t.Errorf("qualifier for a public address does not disclaim verification: %q", got)
	}
	if !strings.Contains(got, "8443") {
		t.Errorf("qualifier does not name the port an owner has to open: %q", got)
	}
}

// TestBannerQualifier_IsNeverEmpty — every address class gets a line. A silent
// banner is the behaviour B6-6 is replacing.
func TestBannerQualifier_IsNeverEmpty(t *testing.T) {
	for _, k := range []netclass.Kind{
		netclass.KindGlobal, netclass.KindPrivate, netclass.KindCGNAT,
		netclass.KindLinkLocal, netclass.KindUniqueLocal, netclass.KindLoopback, netclass.KindOther,
	} {
		if got := bannerQualifier(k, "198.51.100.1", 8443); strings.TrimSpace(got) == "" {
			t.Errorf("bannerQualifier(%q) is empty", k)
		}
	}
}
