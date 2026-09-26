package netclass

import (
	"context"
	"go/parser"
	"go/token"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// Decision 1 of the B6-6 plan: OwnCord adds no outbound reachability helper.
//
// Proving inbound reachability needs a service outside the NAT to call back,
// which would tell a third party this server exists at this address at this
// time — and BPR-055 requires diagnostics stay local. This repository already
// made that call once, against a strictly weaker probe: the startup banner's
// UDP "dial" sent no packet, and was still removed because a packet capture
// saw a connect() at every start (Server/internal/app/banner.go:98-100).
//
// A sentence in a plan does not survive a refactor. These three tests do, and
// each catches a different shape — none of them is sufficient alone, which is
// why all three are here (every one was verified by injecting the violation it
// is meant to catch, then reverting):
//
//   - TestReport_MakesNoOutboundCall catches a helper built on the default
//     HTTP transport or resolver. It does NOT catch a raw net.Dial: Go has no
//     process-wide hook for one, so a STUN-shaped probe would slip past it.
//   - TestNetclassImportsNoNetworkClient catches the import a client needs.
//   - TestNetclassSourceMentionsNoDial is what actually catches the raw dial
//     the recorder cannot see.
//
// If a helper is ever added deliberately, they fail and the decision gets
// re-made in the open rather than drifting in.

// dialRecorder records every connection the process's default transport opens
// and every name it resolves, without changing what happens. Modelled on
// Server/internal/app/no_telemetry_capture_test.go.
type dialRecorder struct {
	mu      sync.Mutex
	dials   []string
	lookups int
}

func (r *dialRecorder) install(t *testing.T) {
	t.Helper()
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		t.Fatal("http.DefaultTransport is not an *http.Transport")
	}
	prevDial := transport.DialContext
	prevResolver := net.DefaultResolver

	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		r.mu.Lock()
		r.dials = append(r.dials, network+" "+addr)
		r.mu.Unlock()
		if prevDial != nil {
			return prevDial(ctx, network, addr)
		}
		return dialer.DialContext(ctx, network, addr)
	}
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			r.mu.Lock()
			r.lookups++
			r.dials = append(r.dials, "resolver "+network+" "+addr)
			r.mu.Unlock()
			return dialer.DialContext(ctx, network, addr)
		},
	}
	t.Cleanup(func() {
		transport.DialContext = prevDial
		net.DefaultResolver = prevResolver
	})
}

// TestReport_MakesNoOutboundCall builds a report for every topology the
// package is meant to handle, and reads the real interface table, and asserts
// that neither opened a socket through the default HTTP transport nor resolved
// a name. Its blind spot is stated in the block comment above; the source scan
// covers it.
func TestReport_MakesNoOutboundCall(t *testing.T) {
	rec := &dialRecorder{}
	rec.install(t)

	// The real interface reader, plus every injected topology.
	_ = LocalAddrs()
	for _, topo := range [][]string{
		{"93.184.216.34"},
		{"192.168.1.50"},
		{"100.64.1.2"},
		{"2606:4700::1111"},
		{"127.0.0.1"},
		{},
	} {
		list := make([]netip.Addr, 0, len(topo))
		for _, s := range topo {
			a, err := netip.ParseAddr(s)
			if err != nil {
				t.Fatalf("ParseAddr(%q): %v", s, err)
			}
			list = append(list, a)
		}
		p := Params{ListenPort: 8443, TLSMode: "acme", VoiceEnabled: true, VoiceNodeIP: "93.184.216.34"}
		if got := BuildReport(list, p); len(got.Undeterminable) == 0 {
			t.Fatal("BuildReport returned an empty Undeterminable list")
		}
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.dials) != 0 {
		t.Errorf("reachability reporting opened %d connection(s): %v — B6-6 decision 1 says it opens none",
			len(rec.dials), rec.dials)
	}
	if rec.lookups != 0 {
		t.Errorf("reachability reporting resolved %d name(s) — it must resolve none", rec.lookups)
	}
}

// outboundPattern names the ways a reachability helper would have to arrive:
// an HTTP or TLS client, a subprocess, or one of the NAT-traversal protocols.
// A legitimate collision is allowlisted here by name, never by loosening the
// pattern — the same rule Server/api/external_dependency_absence_test.go:38
// states for its own vocabulary.
var outboundPattern = regexp.MustCompile(`(?i)^(net/http|net/smtp|crypto/tls|os/exec|net/rpc)$|stun|turn|upnp|nat-?pmp|pcp`)

// TestNetclassImportsNoNetworkClient walks this package's production files and
// refuses the import that would make a probe possible in the first place.
func TestNetclassImportsNoNetworkClient(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading package directory: %v", err)
	}

	fset := token.NewFileSet()
	scanned := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(".", name), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		scanned++
		for _, imp := range f.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			if outboundPattern.MatchString(path) {
				t.Errorf("%s imports %q — netclass must not be able to reach the network (B6-6 decision 1)", name, path)
			}
		}
	}
	if scanned == 0 {
		t.Fatal("scanned no production files; the test would pass vacuously")
	}
}

// TestNetclassSourceMentionsNoDial catches the case the import scan misses: a
// dial reached through a package that is already imported for another reason.
func TestNetclassSourceMentionsNoDial(t *testing.T) {
	banned := []string{"DialContext", "net.Dial", "DefaultTransport", "DefaultClient", "LookupHost", "LookupIP"}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading package directory: %v", err)
	}
	scanned := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		scanned++
		for _, b := range banned {
			if strings.Contains(string(src), b) {
				t.Errorf("%s mentions %s — the reachability report performs no network I/O", name, b)
			}
		}
	}
	if scanned == 0 {
		t.Fatal("scanned no production files; the test would pass vacuously")
	}
}
