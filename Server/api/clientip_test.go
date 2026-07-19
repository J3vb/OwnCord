package api

// White-box tests for clientIP and isTrustedProxy.
// These live in package api (not api_test) so they can reach unexported symbols.

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// ─── isTrustedProxy ───────────────────────────────────────────────────────────

func TestIsTrustedProxy_EmptyList_ReturnsFalse(t *testing.T) {
	trusted, err := isTrustedProxy("10.0.0.1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if trusted {
		t.Error("isTrustedProxy(empty list) = true, want false")
	}
}

func TestIsTrustedProxy_ExactIPMatch(t *testing.T) {
	trusted, err := isTrustedProxy("10.0.0.1", []string{"10.0.0.1/32"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !trusted {
		t.Error("isTrustedProxy exact match = false, want true")
	}
}

func TestIsTrustedProxy_CIDRMatch(t *testing.T) {
	trusted, err := isTrustedProxy("192.168.1.50", []string{"192.168.1.0/24"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !trusted {
		t.Error("isTrustedProxy CIDR match = false, want true")
	}
}

func TestIsTrustedProxy_CIDRNoMatch(t *testing.T) {
	trusted, err := isTrustedProxy("10.9.9.9", []string{"192.168.1.0/24"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if trusted {
		t.Error("isTrustedProxy CIDR non-match = true, want false")
	}
}

func TestIsTrustedProxy_MultipleCIDRs_FirstMatches(t *testing.T) {
	trusted, err := isTrustedProxy("10.0.0.5", []string{"172.16.0.0/12", "10.0.0.0/8"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !trusted {
		t.Error("isTrustedProxy multi-CIDR first match = false, want true")
	}
}

func TestIsTrustedProxy_MultipleCIDRs_NoneMatch(t *testing.T) {
	trusted, err := isTrustedProxy("8.8.8.8", []string{"10.0.0.0/8", "192.168.0.0/16"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if trusted {
		t.Error("isTrustedProxy multi-CIDR no match = true, want false")
	}
}

func TestIsTrustedProxy_InvalidCIDR_ReturnsError(t *testing.T) {
	_, err := isTrustedProxy("10.0.0.1", []string{"not-a-cidr"})
	if err == nil {
		t.Error("isTrustedProxy invalid CIDR should return error, got nil")
	}
}

func TestIsTrustedProxy_BarePlainIP_TreatedAsCIDR32(t *testing.T) {
	// Bare IP without mask — should not panic; behaviour is to return error or
	// treat as /32 depending on implementation. We just verify it doesn't panic.
	_, _ = isTrustedProxy("10.0.0.1", []string{"10.0.0.1"})
}

func TestIsTrustedProxy_IPv6Match(t *testing.T) {
	trusted, err := isTrustedProxy("::1", []string{"::1/128"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !trusted {
		t.Error("isTrustedProxy IPv6 exact match = false, want true")
	}
}

// ─── clientIP with trusted proxies ───────────────────────────────────────────

func TestClientIP_NoTrustedProxies_UsesRemoteAddr(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "203.0.113.5:4321"
	req.Header.Set("X-Real-IP", "1.2.3.4")
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	ip := clientIPWithProxies(req, nil)
	if ip != "203.0.113.5" {
		t.Errorf("clientIP no trusted proxies = %q, want %q", ip, "203.0.113.5")
	}
}

func TestClientIP_TrustedProxy_UsesXRealIP(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:9999"
	req.Header.Set("X-Real-IP", "203.0.113.42")

	ip := clientIPWithProxies(req, []string{"10.0.0.0/8"})
	if ip != "203.0.113.42" {
		t.Errorf("clientIP trusted proxy = %q, want %q", ip, "203.0.113.42")
	}
}

func TestClientIP_TrustedProxy_NoXRealIP_FallsBackToRemoteAddr(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:9999"
	// No X-Real-IP header set.

	ip := clientIPWithProxies(req, []string{"10.0.0.0/8"})
	if ip != "10.0.0.1" {
		t.Errorf("clientIP trusted proxy no header = %q, want %q", ip, "10.0.0.1")
	}
}

func TestClientIP_UntrustedSource_IgnoresXRealIP(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "8.8.8.8:12345"
	req.Header.Set("X-Real-IP", "192.168.1.1") // attacker-supplied

	ip := clientIPWithProxies(req, []string{"10.0.0.0/8"})
	// Must use RemoteAddr, not the forged X-Real-IP.
	if ip != "8.8.8.8" {
		t.Errorf("clientIP untrusted source = %q, want %q", ip, "8.8.8.8")
	}
}

func TestClientIP_XForwardedFor_UsedWhenNoXRealIP(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:9999"
	req.Header.Set("X-Forwarded-For", "203.0.113.10, 10.0.0.1")
	// No X-Real-IP; X-Forwarded-For first entry should be used.

	ip := clientIPWithProxies(req, []string{"10.0.0.0/8"})
	if ip != "203.0.113.10" {
		t.Errorf("clientIP X-Forwarded-For = %q, want %q", ip, "203.0.113.10")
	}
}

// TestClientIP_BroadTrustedCIDRKeepsClientsDistinct locks the W2-5 fix: with
// a trusted_proxies range broad enough to cover the clients themselves, the
// right-to-left walk exhausts; falling back to RemoteAddr would collapse
// every client into the proxy's own bucket (one user's failed logins would
// lock out everyone). The leftmost valid XFF entry keeps clients distinct.
func TestClientIP_BroadTrustedCIDRKeepsClientsDistinct(t *testing.T) {
	trusted := []string{"10.0.0.0/8"} // covers proxy AND LAN clients

	newReq := func(xff string) *http.Request {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = "10.0.0.2:9999" // the proxy
		req.Header.Set("X-Forwarded-For", xff)
		return req
	}

	ip1 := clientIPWithProxies(newReq("10.5.1.7"), trusted)
	ip2 := clientIPWithProxies(newReq("10.5.1.8"), trusted)
	if ip1 != "10.5.1.7" || ip2 != "10.5.1.8" {
		t.Fatalf("clients behind broad trusted CIDR collapsed: ip1=%q ip2=%q", ip1, ip2)
	}

	// Multi-hop: leftmost valid entry (furthest upstream) wins on exhaustion.
	ip3 := clientIPWithProxies(newReq("10.5.1.9, 10.0.0.3"), trusted)
	if ip3 != "10.5.1.9" {
		t.Fatalf("expected furthest-upstream entry, got %q", ip3)
	}
}

// TestClientIP_SpoofedXFFFromUntrustedRemoteIgnored: an untrusted connecting
// address never gets its forwarded headers honoured, exhaustion fallback or
// not.
func TestClientIP_SpoofedXFFFromUntrustedRemoteIgnored(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "203.0.113.9:1234"
	req.Header.Set("X-Forwarded-For", "10.5.1.7")

	ip := clientIPWithProxies(req, []string{"10.0.0.0/8"})
	if ip != "203.0.113.9" {
		t.Fatalf("spoofed XFF from untrusted remote honoured: got %q", ip)
	}
}

func TestClientIP_RemoteAddrWithoutPort(t *testing.T) {
	// RemoteAddr sometimes has no port (e.g. Unix sockets in tests).
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1"

	ip := clientIPWithProxies(req, nil)
	if ip != "10.0.0.1" {
		t.Errorf("clientIP no port = %q, want %q", ip, "10.0.0.1")
	}
}
