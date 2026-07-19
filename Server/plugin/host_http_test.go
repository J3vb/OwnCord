// Pass 4 — host HTTP allowlist + IP guard tests.
//
// Locks in the SSRF defenses added in Pass 2 (dot-bounded host suffix
// matching, empty-entry rejection) and Pass 3 (RFC6598 CGN rejection).
package plugin

import (
	"context"
	"errors"
	"net"
	"testing"
)

func newTestRegistry(allowlist []string) *Registry {
	return &Registry{cfg: Config{HTTPAllowlist: allowlist}}
}

func TestHostAllowedDotBoundary(t *testing.T) {
	r := newTestRegistry([]string{"api.example.com", "example.org"})
	cases := []struct {
		host string
		ok   bool
	}{
		{"api.example.com", true},
		{"v1.api.example.com", true},
		{"example.org", true},
		{"sub.example.org", true},
		// Sibling-domain attack — must NOT match.
		{"evil-api.example.com", false},
		{"notexample.com", false},
		{"example.com", false}, // not in list
		{"evil.com", false},
		{"", false},
		{"api.example.com.evil.com", false},
	}
	for _, c := range cases {
		got := r.hostAllowed(c.host)
		if got != c.ok {
			t.Errorf("hostAllowed(%q) = %v, want %v", c.host, got, c.ok)
		}
	}
}

func TestHostAllowedEmptyEntryRejected(t *testing.T) {
	r := newTestRegistry([]string{""})
	if r.hostAllowed("anything.com") {
		t.Fatal("empty allowlist entry must NOT wildcard-match")
	}
	if r.hostAllowed("") {
		t.Fatal("empty host must not match empty entry")
	}
}

func TestHostAllowedCaseInsensitive(t *testing.T) {
	r := newTestRegistry([]string{"API.Example.COM"})
	if !r.hostAllowed("api.example.com") {
		t.Fatal("hostAllowed should be case-insensitive")
	}
	if !r.hostAllowed("API.example.com") {
		t.Fatal("hostAllowed should be case-insensitive")
	}
}

func TestHostAllowedTrailingDot(t *testing.T) {
	r := newTestRegistry([]string{"api.example.com"})
	if !r.hostAllowed("api.example.com.") {
		t.Fatal("FQDN trailing dot should match")
	}
}

func TestIPAllowedRejectsAllRanges(t *testing.T) {
	cases := []string{
		"127.0.0.1",       // loopback
		"127.5.6.7",       // loopback range
		"10.0.0.1",        // RFC1918
		"172.16.5.5",      // RFC1918
		"172.31.255.255",  // RFC1918 high
		"192.168.1.1",     // RFC1918
		"169.254.169.254", // AWS metadata / link-local
		"100.64.5.5",      // RFC6598 CGN
		"100.127.255.255", // RFC6598 CGN high
		"::1",             // IPv6 loopback
		"fc00::1",         // RFC4193 ULA
		"fe80::1",         // IPv6 link-local
		"0.0.0.0",         // unspecified
		"::",              // IPv6 unspecified
		"224.0.0.1",       // multicast
		"ff00::1",         // IPv6 multicast
	}
	for _, addr := range cases {
		ip := net.ParseIP(addr)
		if ip == nil {
			t.Fatalf("ParseIP(%q) failed", addr)
		}
		if err := ipAllowed(ip); err == nil {
			t.Errorf("ipAllowed(%s) should have returned error", addr)
		}
	}
}

func TestIPAllowedAcceptsPublic(t *testing.T) {
	cases := []string{
		"8.8.8.8",
		"1.1.1.1",
		"203.0.113.5", // RFC5737 documentation but not in any reject set
		"2606:4700:4700::1111",
	}
	for _, addr := range cases {
		ip := net.ParseIP(addr)
		if ip == nil {
			t.Fatalf("ParseIP(%q) failed", addr)
		}
		if err := ipAllowed(ip); err != nil {
			t.Errorf("ipAllowed(%s) should have been allowed, got %v", addr, err)
		}
	}
}

// TestGuardedDial_FallsBackAcrossVettedIPs locks the W2-6 fix: an allowlisted
// dual-stack/round-robin host whose first record is unreachable must connect
// via the next vetted record instead of hard-failing.
func TestGuardedDial_FallsBackAcrossVettedIPs(t *testing.T) {
	origLookup, origDial := lookupIPAddr, dialContext
	t.Cleanup(func() { lookupIPAddr, dialContext = origLookup, origDial })

	lookupIPAddr = func(_ context.Context, _ string) ([]net.IPAddr, error) {
		return []net.IPAddr{
			{IP: net.ParseIP("192.0.2.1")}, // TEST-NET, "down"
			{IP: net.ParseIP("192.0.2.2")}, // "reachable"
		}, nil
	}
	var attempts []string
	c1, c2 := net.Pipe()
	t.Cleanup(func() { _ = c1.Close(); _ = c2.Close() })
	dialContext = func(_ context.Context, _ string, addr string) (net.Conn, error) {
		attempts = append(attempts, addr)
		if addr == "192.0.2.1:443" {
			return nil, errors.New("connection refused")
		}
		return c1, nil
	}

	conn, err := guardedDialContext()(context.Background(), "tcp", "api.example.com:443")
	if err != nil {
		t.Fatalf("guarded dial should fall back to the next vetted IP: %v", err)
	}
	if conn != c1 {
		t.Fatal("expected the fallback connection")
	}
	want := []string{"192.0.2.1:443", "192.0.2.2:443"}
	if len(attempts) != 2 || attempts[0] != want[0] || attempts[1] != want[1] {
		t.Fatalf("dial attempts = %v, want %v", attempts, want)
	}
}

// TestGuardedDial_PrivateRecordRefusesBeforeAnyDial: one private record among
// the resolved set refuses the whole request before a single dial happens.
func TestGuardedDial_PrivateRecordRefusesBeforeAnyDial(t *testing.T) {
	origLookup, origDial := lookupIPAddr, dialContext
	t.Cleanup(func() { lookupIPAddr, dialContext = origLookup, origDial })

	lookupIPAddr = func(_ context.Context, _ string) ([]net.IPAddr, error) {
		return []net.IPAddr{
			{IP: net.ParseIP("192.0.2.1")},
			{IP: net.ParseIP("10.0.0.5")}, // poisoned private record
		}, nil
	}
	dialed := false
	dialContext = func(_ context.Context, _ string, _ string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("must not be reached")
	}

	_, err := guardedDialContext()(context.Background(), "tcp", "api.example.com:443")
	if !errors.Is(err, ErrHTTPHostDenied) {
		t.Fatalf("want ErrHTTPHostDenied, got %v", err)
	}
	if dialed {
		t.Fatal("no dial may happen when any resolved record is private")
	}
}

func TestIPAllowedNilRejected(t *testing.T) {
	if err := ipAllowed(nil); err == nil {
		t.Fatal("nil IP should be rejected")
	}
}
