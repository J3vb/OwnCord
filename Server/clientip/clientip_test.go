package clientip

// SRE-11: the proxy-aware client-IP resolution api/middleware.go owned
// privately is extracted here so the WebSocket handshake can use the same
// algorithm instead of logging and auditing r.RemoteAddr (the reverse proxy's
// address). api/middleware.go now delegates to it and its own clientip_test.go
// still pins the behaviour end to end.
//
// The security model is unchanged from api's clientIPWithProxies:
//   - Always parse the connecting address from r.RemoteAddr.
//   - Only honour X-Real-IP/X-Forwarded-For when the connecting address
//     matches a trusted network, so a client cannot forge its IP.
//   - With no trusted networks (the default), RemoteAddr is always used.

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func req(remote string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = remote
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

// TestResolve_NoTrustedProxies pins the default: RemoteAddr is used and a
// client-supplied header cannot move it.
func TestResolve_NoTrustedProxies(t *testing.T) {
	got := Resolve(req("203.0.113.5:4321", map[string]string{
		"X-Forwarded-For": "1.2.3.4",
		"X-Real-IP":       "1.2.3.4",
	}), nil)
	if got != "203.0.113.5" {
		t.Errorf("Resolve with no trusted proxies = %q, want 203.0.113.5", got)
	}
}

// TestResolve_TrustedProxyUsesXFF pins the fix: from a trusted proxy, the
// rightmost non-proxy X-Forwarded-For entry is the client.
func TestResolve_TrustedProxyUsesXFF(t *testing.T) {
	nets := ParseCIDRList([]string{"10.0.0.0/8"})
	got := Resolve(req("10.0.0.9:4321", map[string]string{
		"X-Forwarded-For": "203.0.113.7, 10.0.0.9",
	}), nets)
	if got != "203.0.113.7" {
		t.Errorf("Resolve from a trusted proxy = %q, want 203.0.113.7", got)
	}
}

// TestResolve_UntrustedSourceIgnoresHeaders pins the spoof guard: an untrusted
// connecting address never lets a header override RemoteAddr.
func TestResolve_UntrustedSourceIgnoresHeaders(t *testing.T) {
	nets := ParseCIDRList([]string{"10.0.0.0/8"})
	got := Resolve(req("8.8.8.8:12345", map[string]string{
		"X-Forwarded-For": "203.0.113.7",
		"X-Real-IP":       "192.168.1.1",
	}), nets)
	if got != "8.8.8.8" {
		t.Errorf("Resolve from an untrusted source = %q, want 8.8.8.8", got)
	}
}

// TestResolve_SpoofedLeadingXFFWalkedPast pins BUG-112: an attacker-prepended
// IP must not win the right-to-left walk.
func TestResolve_SpoofedLeadingXFFWalkedPast(t *testing.T) {
	nets := ParseCIDRList([]string{"10.0.0.0/8"})
	got := Resolve(req("10.0.0.9:4321", map[string]string{
		"X-Forwarded-For": "192.0.2.66, 203.0.113.7, 10.0.0.9",
	}), nets)
	if got != "203.0.113.7" {
		t.Errorf("Resolve = %q, want the proxy-appended 203.0.113.7 (not the spoofed leading IP)", got)
	}
}

// TestResolve_XRealIPLastResort pins that X-Real-IP is only used when
// X-Forwarded-For is absent or wholly unusable, and is validated.
func TestResolve_XRealIPLastResort(t *testing.T) {
	nets := ParseCIDRList([]string{"10.0.0.0/8"})
	if got := Resolve(req("10.0.0.9:4321", map[string]string{"X-Real-IP": "203.0.113.42"}), nets); got != "203.0.113.42" {
		t.Errorf("Resolve with only X-Real-IP = %q, want 203.0.113.42", got)
	}
	if got := Resolve(req("10.0.0.9:4321", map[string]string{"X-Real-IP": "not-an-ip"}), nets); got != "10.0.0.9" {
		t.Errorf("Resolve with a malformed X-Real-IP = %q, want RemoteAddr 10.0.0.9", got)
	}
}

// TestResolve_BroadTrustedCIDRKeepsClientsDistinct pins the LAN-clients case:
// when every XFF entry is inside trustedNets, the leftmost valid entry is the
// best distinct per-client key, not RemoteAddr (which would collapse all
// clients behind the proxy into one bucket).
func TestResolve_BroadTrustedCIDRKeepsClientsDistinct(t *testing.T) {
	nets := ParseCIDRList([]string{"10.0.0.0/8"})
	got := Resolve(req("10.0.0.9:4321", map[string]string{
		"X-Forwarded-For": "10.1.2.3, 10.0.0.9",
	}), nets)
	if got != "10.1.2.3" {
		t.Errorf("Resolve with a broad trusted CIDR = %q, want the leftmost 10.1.2.3", got)
	}
}

// TestResolve_RemoteAddrWithoutPort pins the Unix-socket/test-stub case.
func TestResolve_RemoteAddrWithoutPort(t *testing.T) {
	if got := Resolve(req("203.0.113.5", nil), nil); got != "203.0.113.5" {
		t.Errorf("Resolve with a portless RemoteAddr = %q, want 203.0.113.5", got)
	}
}

// TestParseCIDRList_SkipsInvalid pins the warn-never-fail contract: an invalid
// entry is skipped without error.
func TestParseCIDRList_SkipsInvalid(t *testing.T) {
	if nets := ParseCIDRList([]string{"not-a-cidr", "10.0.0.0/8"}); len(nets) != 1 {
		t.Errorf("ParseCIDRList = %d nets, want 1 (invalid skipped)", len(nets))
	}
}
