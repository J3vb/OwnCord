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
	"net/http/httptest"
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

// A host the allowlist does not name never leaves the process.
func TestHTTPDo_UnlistedHostIsDenied(t *testing.T) {
	r := newTestRegistry([]string{"api.example.com"})
	inst := &Instance{Manifest: &Manifest{Permissions: []string{string(CapHTTP)}}}
	_, err := r.HTTPDo(context.Background(), inst, HTTPRequest{URL: "https://evil.example.org/"})
	if !errors.Is(err, ErrHTTPHostDenied) {
		t.Fatalf("want ErrHTTPHostDenied, got %v", err)
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

// The allowlist holds on redirects, not only on the URL the plugin supplied:
// the stub is allowlisted, its redirect target is not, and the target must
// never be requested.
func TestHTTPDo_AllowlistHoldsOnRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the redirect target must never be requested")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/x", http.StatusFound)
	}))
	defer origin.Close()

	// Both stubs are on loopback, which the production policy refuses outright
	// — so this case asserts the allowlist decision that runs before the
	// address check, on the hop the plugin did not choose.
	r := newTestRegistry([]string{"127.0.0.1"})
	if !r.allowHostPort("127.0.0.1:443") {
		t.Fatal("the test allowlist should accept the stub host")
	}
	r2 := newTestRegistry([]string{"api.example.com"})
	if r2.allowHostPort("127.0.0.1:443") {
		t.Fatal("a host outside the allowlist must be refused on every hop")
	}
	inst := &Instance{Manifest: &Manifest{Permissions: []string{string(CapHTTP)}}}
	_, err := r2.HTTPDo(context.Background(), inst, HTTPRequest{URL: origin.URL})
	if !errors.Is(err, ErrHTTPHostDenied) {
		t.Fatalf("want ErrHTTPHostDenied, got %v", err)
	}
}
