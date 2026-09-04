package safefetch

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"time"
)

// maxRedirectBudget is the largest hop count a policy may ask for. "A small
// fixed number" is the C-09 contract's wording; anything past this is a
// caller confusing a redirect chain with a crawl.
const maxRedirectBudget = 10

// maxConcurrencyBudget bounds a single Fetcher's cap. The process gate below
// is the real ceiling; this only catches a typo'd policy.
const maxConcurrencyBudget = 256

// processConcurrency bounds fetches in flight across every Fetcher in the
// process, so a caller cannot buy more of the server's sockets by
// constructing more Fetchers.
//
// This is also where B5 decision 2's deferred aggregate byte budget goes: it
// is the one admission point every fetch already passes.
const processConcurrency = 32

// processGate is a var only so TestFetch_ProcessGateBoundsEveryFetcher can
// swap in a smaller one; nothing in production reassigns it.
var processGate = make(semaphore, processConcurrency)

// Policy is one call site's outbound-content policy. Every field is required
// unless its documentation says otherwise: New refuses a policy with a
// missing ceiling rather than inventing a default, because a default nobody
// chose is how a call site ends up unbounded.
type Policy struct {
	// Schemes is the allowed URL schemes, lowercase. Only "http" and "https"
	// are accepted; a policy that lists "https" alone also refuses a redirect
	// that tries to move to "http".
	Schemes []string

	// Ports is the allowed destination ports. Empty means the default port of
	// each allowed scheme (80, 443) and nothing else.
	Ports []int

	// ContentTypes is the media-type allowlist, without parameters and in
	// lowercase. Both the declared type and the type sniffed from the body
	// must appear in it. http.DetectContentType reports "text/plain" for
	// every textual format, so a policy that allows "application/json" must
	// allow "text/plain" too; the pairing still refuses an HTML error page
	// wearing a JSON Content-Type, which is the attack this catches.
	//
	// Empty disables the check. That is only ever right for a caller that
	// treats the body as opaque bytes, and no call site in this repository
	// does.
	ContentTypes []string

	// MaxRedirects is how many hops may be followed by hand. 0 refuses every
	// redirect. Automatic following is off in all cases.
	MaxRedirects int

	// Deadline bounds the whole fetch: connect, TLS, every redirect hop, and
	// the last byte of the body.
	Deadline time.Duration

	// MaxBytes bounds the bytes read off the wire, enforced while reading.
	MaxBytes int64

	// MaxDecompressedBytes bounds the body after inflation. It is a separate
	// number because a gzip stream well under MaxBytes can inflate past any
	// amount of memory.
	MaxDecompressedBytes int64

	// MaxConcurrent bounds this Fetcher's fetches in flight. A caller over
	// the cap waits for a slot until its context expires.
	MaxConcurrent int

	// Classify decides whether one resolved address may be dialled. nil
	// selects ClassifyAddr, which is the policy in docs/trust-model.md.
	//
	// It is a seam for tests that must reach a loopback stub, and for B7 to
	// layer its own classification on top. No production call site in this
	// repository sets it, and TestNoProductionOverrideOfSeams proves that.
	Classify func(netip.Addr) error

	// Resolve returns every address a host resolves to. nil selects the
	// system resolver over both address families.
	Resolve func(ctx context.Context, host string) ([]netip.Addr, error)

	// Dial opens one connection to an already-validated concrete address.
	// nil selects a plain net.Dialer. It never sees a hostname.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

// Fetcher performs bounded fetches under one Policy. Build one per call site
// at start-up and share it: it owns the concurrency cap and the connection
// pool. It is safe for concurrent use.
type Fetcher struct {
	policy   Policy
	ports    []int
	classify func(netip.Addr) error
	resolve  func(ctx context.Context, host string) ([]netip.Addr, error)
	dialer   func(ctx context.Context, network, addr string) (net.Conn, error)
	gate     semaphore
	client   *http.Client
}

// New validates p and returns a Fetcher for it.
func New(p Policy) (*Fetcher, error) {
	ports, err := p.check()
	if err != nil {
		return nil, err
	}
	// The caller keeps its own Policy value, and its slice fields alias the
	// same backing arrays. Copy them, or a later append or index write on the
	// caller's side silently changes what this Fetcher allows.
	p.Schemes = slices.Clone(p.Schemes)
	p.ContentTypes = slices.Clone(p.ContentTypes)
	p.Ports = slices.Clone(p.Ports)
	f := &Fetcher{
		policy:   p,
		ports:    ports,
		classify: ClassifyAddr,
		resolve:  defaultResolve,
		dialer:   defaultDial,
		gate:     make(semaphore, p.MaxConcurrent),
	}
	if p.Classify != nil {
		f.classify = p.Classify
	}
	if p.Resolve != nil {
		f.resolve = p.Resolve
	}
	if p.Dial != nil {
		f.dialer = p.Dial
	}
	f.client = &http.Client{
		// Proxy stays nil: a proxy would carry the request to a host this
		// package never validated, and env-configured proxying is exactly
		// the kind of ambient authority a destination policy must not have.
		Transport: &http.Transport{
			DialContext:         f.dial,
			DisableCompression:  true, // the body ceilings need to see the wire bytes
			MaxIdleConns:        8,
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     30 * time.Second,
			TLSHandshakeTimeout: 10 * time.Second,
		},
		// Redirects are followed by hand in follow(), one hop at a time, so
		// that the whole destination check runs again on each of them.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return f, nil
}

// MustNew is New for a policy fixed at compile time, which is every policy in
// this repository: a call site's ceilings are constants, so a policy New
// refuses is a programming error that a test catches, not a runtime condition
// to handle. It panics rather than returning a Fetcher that is not bounded.
func MustNew(p Policy) *Fetcher {
	f, err := New(p)
	if err != nil {
		panic(err)
	}
	return f
}

// check validates the policy and returns the effective port allowlist.
func (p Policy) check() ([]int, error) {
	if len(p.Schemes) == 0 {
		return nil, fmt.Errorf("%w: Schemes is empty", ErrPolicy)
	}
	for _, s := range p.Schemes {
		if s != "http" && s != "https" {
			return nil, fmt.Errorf("%w: scheme %q is not http or https", ErrPolicy, s)
		}
	}
	for _, n := range []struct {
		name string
		v    int64
	}{
		{"Deadline", int64(p.Deadline)},
		{"MaxBytes", p.MaxBytes},
		{"MaxDecompressedBytes", p.MaxDecompressedBytes},
		{"MaxConcurrent", int64(p.MaxConcurrent)},
	} {
		if n.v <= 0 {
			return nil, fmt.Errorf("%w: %s must be positive, got %d", ErrPolicy, n.name, n.v)
		}
	}
	if p.MaxConcurrent > maxConcurrencyBudget {
		return nil, fmt.Errorf("%w: MaxConcurrent %d is over the %d budget", ErrPolicy, p.MaxConcurrent, maxConcurrencyBudget)
	}
	if p.MaxRedirects < 0 || p.MaxRedirects > maxRedirectBudget {
		return nil, fmt.Errorf("%w: MaxRedirects must be 0..%d, got %d", ErrPolicy, maxRedirectBudget, p.MaxRedirects)
	}
	return p.effectivePorts()
}

// effectivePorts resolves Policy.Ports, defaulting to the allowed schemes'
// own ports when it is empty.
func (p Policy) effectivePorts() ([]int, error) {
	if len(p.Ports) == 0 {
		var out []int
		if slices.Contains(p.Schemes, "http") {
			out = append(out, 80)
		}
		if slices.Contains(p.Schemes, "https") {
			out = append(out, 443)
		}
		return out, nil
	}
	for _, port := range p.Ports {
		if port < 1 || port > 65535 {
			return nil, fmt.Errorf("%w: port %d is out of range", ErrPolicy, port)
		}
	}
	return slices.Clone(p.Ports), nil
}

// typeAllowed reports whether a normalised media type is on the allowlist.
func (f *Fetcher) typeAllowed(mediaType string) bool {
	for _, allowed := range f.policy.ContentTypes {
		if strings.EqualFold(allowed, mediaType) {
			return true
		}
	}
	return false
}

func defaultResolve(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

func defaultDial(ctx context.Context, network, addr string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, network, addr)
}

// semaphore is a counting gate whose wait is cancellable.
type semaphore chan struct{}

func (s semaphore) acquire(ctx context.Context) error {
	select {
	case s <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s semaphore) release() { <-s }
