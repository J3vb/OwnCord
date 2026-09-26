// Host HTTP allowlist tests.
//
// Locks in the dot-bounded host suffix matching and empty-entry rejection,
// and — since B5-1 moved the destination policy into Server/safefetch — that
// HTTPDo actually applies that policy, on the first hop and on redirects
// alike. The address classifier's own cases live in Server/safefetch, which
// is where the classifier now lives.
package plugin

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/safefetch"
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

// An allowlisted host that resolves somewhere non-global is still refused,
// and the refusal is ErrHTTPHostDenied — the sentinel this package's callers
// test for — rather than safefetch's own error leaking through.
func TestHTTPDo_AllowlistedHostResolvingPrivateIsDenied(t *testing.T) {
	r := newTestRegistry([]string{"127.0.0.1", "169.254.169.254", "10.0.0.5", "metadata.invalid"})
	inst := &Instance{Manifest: &Manifest{Permissions: []string{string(CapHTTP)}}}
	for _, target := range []string{
		"http://127.0.0.1/",
		"http://169.254.169.254/latest/meta-data/",
		"https://10.0.0.5/",
	} {
		_, err := r.HTTPDo(context.Background(), inst, HTTPRequest{Method: http.MethodGet, URL: target})
		if !errors.Is(err, ErrHTTPHostDenied) {
			t.Errorf("%s: want ErrHTTPHostDenied, got %v", target, err)
		}
		if !errors.Is(err, safefetch.ErrBlockedAddress) {
			t.Errorf("%s: the refusal should carry safefetch's reason, got %v", target, err)
		}
	}
}

// A host the allowlist does not name never leaves the process — and is
// refused by the allowlist rather than by failing to resolve, which is what
// makes this the test that fails if Request.AllowHost stops being wired.
// .invalid never resolves (RFC 6761), so an unwired allowlist shows up as a
// DNS error instead of a denial.
func TestHTTPDo_UnlistedHostIsDenied(t *testing.T) {
	r := newTestRegistry([]string{"api.example.com"})
	inst := &Instance{Manifest: &Manifest{Permissions: []string{string(CapHTTP)}}}
	_, err := r.HTTPDo(context.Background(), inst, HTTPRequest{URL: "https://evil.invalid/"})
	if !errors.Is(err, ErrHTTPHostDenied) {
		t.Fatalf("want ErrHTTPHostDenied, got %v", err)
	}
	if !errors.Is(err, safefetch.ErrHostNotAllowed) {
		t.Fatalf("the refusal must come from the allowlist, not from anything downstream: %v", err)
	}
	if errors.Is(err, safefetch.ErrResolve) {
		t.Fatal("the host was resolved — the allowlist is no longer wired into the fetch")
	}
}

// Schemes outside http and https are refused before anything is resolved.
func TestHTTPDo_NonHTTPSchemeIsDenied(t *testing.T) {
	r := newTestRegistry([]string{"example.com"})
	inst := &Instance{Manifest: &Manifest{Permissions: []string{string(CapHTTP)}}}
	for _, target := range []string{"file:///etc/passwd", "gopher://example.com:70/", "ftp://example.com/x"} {
		if _, err := r.HTTPDo(context.Background(), inst, HTTPRequest{URL: target}); !errors.Is(err, ErrHTTPHostDenied) {
			t.Errorf("%s: want ErrHTTPHostDenied, got %v", target, err)
		}
	}
}

// The capability gate still comes first: no manifest grant, no request.
func TestHTTPDo_RequiresTheCapability(t *testing.T) {
	r := newTestRegistry([]string{"example.com"})
	inst := &Instance{Manifest: &Manifest{}}
	_, err := r.HTTPDo(context.Background(), inst, HTTPRequest{URL: "https://example.com/"})
	if !errors.Is(err, ErrCapabilityNotGranted) {
		t.Fatalf("want ErrCapabilityNotGranted, got %v", err)
	}
}

// The allowlist is applied per hop, not only to the URL the plugin supplied.
//
// This cannot be driven through a real redirect from here: the production
// policy's port allowlist is [80, 443], so no httptest stub is reachable at
// all, and HTTPDo's own pre-check refuses a loopback host before safefetch is
// even called. What this asserts is the wiring — that the function HTTPDo
// hands to safefetch as Request.AllowHost is the allowlist, applied to a
// "host:port" with the port stripped. That safefetch then consults it on
// every hop is safefetch.TestFetch_AllowHostAppliesToEveryHop's job, and the
// earlier version of this test claimed to do both and did neither.
func TestAllowHostPortAppliesTheAllowlist(t *testing.T) {
	r := newTestRegistry([]string{"api.example.com", "example.org"})
	cases := []struct {
		hostport string
		ok       bool
	}{
		{"api.example.com:443", true},
		{"api.example.com:80", true},
		{"api.example.com", true},
		{"v1.api.example.com:443", true},
		{"sub.example.org:443", true},
		{"evil-api.example.com:443", false},
		{"api.example.com.evil.com:443", false},
		{"127.0.0.1:8080", false},
		{"", false},
	}
	for _, c := range cases {
		if got := r.allowHostPort(c.hostport); got != c.ok {
			t.Errorf("allowHostPort(%q) = %v, want %v", c.hostport, got, c.ok)
		}
	}
}

// HTTPDo actually passes that function through, rather than leaving
// Request.AllowHost nil and losing the per-hop check. An allowlisted host
// that resolves nowhere reaches safefetch, so the refusal that comes back
// proves the request was built and handed over.
func TestHTTPDo_PassesTheAllowlistToSafefetch(t *testing.T) {
	r := newTestRegistry([]string{"example.com"})
	inst := &Instance{Manifest: &Manifest{Permissions: []string{string(CapHTTP)}}}

	// A host the allowlist names, on a port the policy does not: safefetch
	// refuses it, which it could only do having been called.
	_, err := r.HTTPDo(context.Background(), inst, HTTPRequest{URL: "https://example.com:8443/"})
	if !errors.Is(err, safefetch.ErrBlockedPort) {
		t.Fatalf("want safefetch.ErrBlockedPort, got %v", err)
	}
	if !errors.Is(err, ErrHTTPHostDenied) {
		t.Fatalf("a destination refusal must still carry ErrHTTPHostDenied, got %v", err)
	}
}
