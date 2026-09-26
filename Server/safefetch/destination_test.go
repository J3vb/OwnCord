package safefetch

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"testing"
	"time"
)

// resolverPolicy is a policy with no live network at all: the resolver and
// the dialer are both stubs, so a case can decide exactly what DNS says and
// observe exactly what was dialled.
func resolverPolicy(answers []netip.Addr, dialed *[]string) Policy {
	return Policy{
		Schemes:              []string{"https"},
		Ports:                []int{443},
		MaxRedirects:         3,
		Deadline:             2 * time.Second,
		MaxBytes:             1 << 20,
		MaxDecompressedBytes: 1 << 20,
		MaxConcurrent:        4,
		Resolve: func(context.Context, string) ([]netip.Addr, error) {
			return answers, nil
		},
		Dial: func(_ context.Context, _, addr string) (net.Conn, error) {
			*dialed = append(*dialed, addr)
			return nil, errors.New("stub dialer: no connection")
		},
	}
}

func mustNew(t *testing.T, p Policy) *Fetcher {
	t.Helper()
	f, err := New(p)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

// A name that resolves into a blocked class is refused, and — the part that
// matters — refused before any dial happens.
func TestFetch_BlockedResolutionNeverDials(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.0.0.5", "169.254.169.254", "192.0.2.7", "::1", "fe80::1", "::ffff:127.0.0.1"} {
		var dialed []string
		f := mustNew(t, resolverPolicy([]netip.Addr{netip.MustParseAddr(s)}, &dialed))
		_, err := get(f, "https://host.invalid/")
		if !errors.Is(err, ErrBlockedAddress) {
			t.Errorf("resolving to %s: want ErrBlockedAddress, got %v", s, err)
		}
		if len(dialed) != 0 {
			t.Errorf("resolving to %s: dialled %v — the check must precede the dial", s, dialed)
		}
	}
}

// A mixed answer set — one public record, one poisoned — refuses the whole
// request. Dialling the "good" record would leave the attacker one retry away
// from the bad one, and would depend on answer order.
func TestFetch_MixedAnswerSetRefusesEverything(t *testing.T) {
	var dialed []string
	f := mustNew(t, resolverPolicy([]netip.Addr{
		netip.MustParseAddr("93.184.216.34"),
		netip.MustParseAddr("10.0.0.5"),
	}, &dialed))
	_, err := get(f, "https://host.invalid/")
	if !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("want ErrBlockedAddress, got %v", err)
	}
	if len(dialed) != 0 {
		t.Fatalf("no dial may happen when any record is blocked, dialled %v", dialed)
	}
}

// A CNAME chain is only visible here as the address set the final name
// resolves to: whatever the chain's length, the answer is what is judged.
func TestFetch_CNAMEChainJudgedOnFinalAddresses(t *testing.T) {
	var dialed []string
	p := resolverPolicy(nil, &dialed)
	hops := 0
	p.Resolve = func(context.Context, string) ([]netip.Addr, error) {
		hops++
		return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
	}
	f := mustNew(t, p)
	_, err := get(f, "https://front.invalid/")
	if !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("want ErrBlockedAddress for a chain ending on link-local, got %v", err)
	}
	if hops != 1 {
		t.Fatalf("the host must be resolved exactly once, got %d lookups", hops)
	}
	if len(dialed) != 0 {
		t.Fatalf("dialled %v", dialed)
	}
}

// The rebinding TOCTOU: DNS answers a public address when asked, then a
// private one. Only one lookup may happen, and the dial must go to the
// address that was validated — never to a fresh answer.
func TestFetch_AddressChangeBetweenValidationAndConnect(t *testing.T) {
	var dialed []string
	p := resolverPolicy(nil, &dialed)
	calls := 0
	p.Resolve = func(context.Context, string) ([]netip.Addr, error) {
		calls++
		if calls == 1 {
			return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	f := mustNew(t, p)
	_, _ = get(f, "https://rebind.invalid/")
	if calls != 1 {
		t.Fatalf("the destination must be resolved once, got %d lookups — a second lookup reopens the rebinding window", calls)
	}
	if len(dialed) != 1 || dialed[0] != "93.184.216.34:443" {
		t.Fatalf("dialled %v, want exactly the validated address 93.184.216.34:443", dialed)
	}
}

// Every vetted address is tried: a dual-stack or round-robin host whose first
// record is down must still connect through the next one.
func TestFetch_TriesEveryVettedAddress(t *testing.T) {
	var dialed []string
	f := mustNew(t, resolverPolicy([]netip.Addr{
		netip.MustParseAddr("93.184.216.34"),
		netip.MustParseAddr("2606:4700:4700::1111"),
	}, &dialed))
	_, _ = get(f, "https://host.invalid/")
	want := []string{"93.184.216.34:443", "[2606:4700:4700::1111]:443"}
	if len(dialed) != 2 || dialed[0] != want[0] || dialed[1] != want[1] {
		t.Fatalf("dialled %v, want %v", dialed, want)
	}
}

// An empty answer set is a refusal, not an unbounded dial.
func TestFetch_EmptyAnswerSet(t *testing.T) {
	var dialed []string
	f := mustNew(t, resolverPolicy(nil, &dialed))
	_, err := get(f, "https://host.invalid/")
	if !errors.Is(err, ErrNoAddresses) {
		t.Fatalf("want ErrNoAddresses, got %v", err)
	}
}

// Offline: resolution fails. The caller gets a resolve error, not a policy
// refusal, so a server with no DNS is distinguishable from a blocked target.
func TestFetch_OfflineResolveFailure(t *testing.T) {
	var dialed []string
	p := resolverPolicy(nil, &dialed)
	p.Resolve = func(context.Context, string) ([]netip.Addr, error) {
		return nil, &net.DNSError{Err: "no such host", Name: "host.invalid", IsNotFound: true}
	}
	f := mustNew(t, p)
	_, err := get(f, "https://host.invalid/")
	if !errors.Is(err, ErrResolve) {
		t.Fatalf("want ErrResolve, got %v", err)
	}
	if errors.Is(err, ErrBlockedAddress) {
		t.Fatal("a DNS failure must not masquerade as a blocked destination")
	}
}

// Offline: the address resolves and passes policy, but nothing answers.
func TestFetch_OfflineDialFailure(t *testing.T) {
	var dialed []string
	f := mustNew(t, resolverPolicy([]netip.Addr{netip.MustParseAddr("93.184.216.34")}, &dialed))
	_, err := get(f, "https://host.invalid/")
	if err == nil {
		t.Fatal("want an error when the dial fails")
	}
	if errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("an unreachable host must not read as a blocked one: %v", err)
	}
}

// An IP literal in the URL is classified directly — no resolver involved, and
// no way to smuggle a blocked address past the check by skipping DNS.
func TestFetch_IPLiteralIsClassified(t *testing.T) {
	var dialed []string
	p := resolverPolicy(nil, &dialed)
	p.Resolve = func(context.Context, string) ([]netip.Addr, error) {
		t.Error("an IP literal must not be resolved")
		return nil, nil
	}
	f := mustNew(t, p)
	for _, host := range []string{"127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "169.254.169.254"} {
		_, err := get(f, "https://"+host+"/x")
		if !errors.Is(err, ErrBlockedAddress) {
			t.Errorf("literal %s: want ErrBlockedAddress, got %v", host, err)
			continue
		}
		// The refusal must come from the destination check, before a request
		// exists. The dial-time re-check would also refuse this, but its
		// error arrives wrapped in a *url.Error from client.Do — which is
		// how this case tells the two apart.
		var wrapped *url.Error
		if errors.As(err, &wrapped) {
			t.Errorf("literal %s was refused at dial time, not by the destination check: %v", host, err)
		}
	}
	if len(dialed) != 0 {
		t.Fatalf("dialled %v", dialed)
	}
}

// URL-shaped refusals: schemes, ports and embedded credentials.
func TestFetch_URLPolicy(t *testing.T) {
	var dialed []string
	f := mustNew(t, resolverPolicy([]netip.Addr{netip.MustParseAddr("93.184.216.34")}, &dialed))
	cases := []struct {
		url  string
		want error
	}{
		{"http://host.invalid/", ErrBlockedScheme},
		{"file:///etc/passwd", ErrBlockedScheme},
		{"gopher://host.invalid:70/", ErrBlockedScheme},
		{"ftp://host.invalid/", ErrBlockedScheme},
		{"https://host.invalid:8443/", ErrBlockedPort},
		{"https://host.invalid:22/", ErrBlockedPort},
		{"https://user:pass@host.invalid/", ErrCredentialsInURL},
		{"https://user@host.invalid/", ErrCredentialsInURL},
		{"https:///nohost", ErrInvalidURL},
		{"::not a url::", ErrInvalidURL},
		{"https://host.invalid:notaport/", ErrInvalidURL},
	}
	for _, c := range cases {
		_, err := get(f, c.url)
		if !errors.Is(err, c.want) {
			t.Errorf("%s: want %v, got %v", c.url, c.want, err)
		}
	}
	if len(dialed) != 0 {
		t.Fatalf("a URL-shaped refusal must never dial, dialled %v", dialed)
	}
}

// The dial is bound to the destination the policy vetted. Both ways of
// arriving somewhere else — no vetted destination at all, and a request for a
// host the vetted destination does not name — fail closed. Nothing in
// Fetcher.follow can produce either today; this is the backstop that keeps it
// that way if something later reuses the transport.
func TestFetch_DialBindingRejectsAnUnvettedAddress(t *testing.T) {
	var dialed []string
	f := mustNew(t, resolverPolicy([]netip.Addr{netip.MustParseAddr("93.184.216.34")}, &dialed))

	if _, err := f.dial(context.Background(), "tcp", "93.184.216.34:443"); !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("a dial with no validated destination must fail closed, got %v", err)
	}
	u, err := url.Parse("https://good.invalid/")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	ctx := context.WithValue(context.Background(), vettedKey{}, &destination{
		url: u, host: "good.invalid", port: "443",
		addrs: []netip.Addr{netip.MustParseAddr("93.184.216.34")},
	})
	for _, addr := range []string{"evil.invalid:443", "good.invalid:8443"} {
		if _, err := f.dial(ctx, "tcp", addr); !errors.Is(err, ErrBlockedAddress) {
			t.Errorf("dial to %s against a destination for good.invalid:443 must fail closed, got %v", addr, err)
		}
	}
	if len(dialed) != 0 {
		t.Fatalf("dialled %v", dialed)
	}
}
