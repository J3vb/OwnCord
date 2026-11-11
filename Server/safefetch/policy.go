package safefetch

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"time"
)

// maxRedirectBudget caps a policy's hop count.
const maxRedirectBudget = 10

// maxConcurrencyBudget only catches a typo'd policy; the process gate is the real ceiling.
const maxConcurrencyBudget = 256

// processConcurrency bounds fetches in flight across every Fetcher, so more
// Fetchers cannot buy more of the server's sockets.
const processConcurrency = 32

// processGate is a var only so a test can swap in a smaller one.
var processGate = make(semaphore, processConcurrency)

// Policy is one call site's outbound-content policy. Every field is required
// unless noted: New refuses a missing ceiling rather than inventing a default.
type Policy struct {
	// Schemes is the allowed URL schemes, lowercase ("http" and "https" only);
	// listing "https" alone also refuses a redirect to "http".
	Schemes []string

	// Ports is the allowed destination ports; empty means each allowed scheme's default and nothing else.
	Ports []int

	// ContentTypes is the lowercase media-type allowlist; both the declared and
	// the sniffed type must appear in it. DetectContentType reports "text/plain"
	// for every textual format, so allowing "application/json" needs "text/plain"
	// too; the pairing still refuses an HTML page wearing a JSON Content-Type.
	// Empty disables the check, which no call site here does.
	ContentTypes []string

	// MaxRedirects is how many hops are followed; 0 refuses every redirect.
	MaxRedirects int

	// Deadline bounds the whole fetch.
	Deadline time.Duration

	// MaxBytes bounds the bytes read off the wire, enforced while reading.
	MaxBytes int64

	// MaxDecompressedBytes bounds the body after inflation, since a small gzip
	// stream can inflate past any amount of memory.
	MaxDecompressedBytes int64

	// MaxConcurrent bounds this Fetcher's fetches in flight; a caller over the cap waits for a slot until
	// its context expires.
	MaxConcurrent int

	// Truncate returns the first MaxDecompressedBytes of a longer body instead of
	// refusing it, for callers that parse only a prefix. MaxBytes still bounds the
	// wire bytes and the content type is judged on the kept prefix.
	Truncate bool

	// Classify decides whether an address may be dialled; nil selects
	// ClassifyAddr. A test seam: no production call site sets it.
	Classify func(netip.Addr) error

	// Resolve returns every address a host resolves to; nil is the system resolver.
	Resolve func(ctx context.Context, host string) ([]netip.Addr, error)

	// Dial opens one connection to a validated address (never a hostname); nil selects net.Dialer.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)

	// TLSConfig is the client TLS configuration; nil selects system roots and
	// full verification. A test seam like the three above: a config trusting a
	// private CA or skipping verification opts out of validation, so
	// production code must not set it.
	TLSConfig *tls.Config
}

// Fetcher performs bounded fetches under one Policy. Build one per call site
// and share it; it is safe for concurrent use.
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
	// Copy the caller's slices so a later write on its side cannot change what this Fetcher allows.
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
		// package never validated (ambient authority).
		Transport: &http.Transport{
			DialContext:         f.dial,
			TLSClientConfig:     p.TLSConfig,
			DisableCompression:  true, // the body ceilings need to see the wire bytes
			MaxIdleConns:        8,
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     30 * time.Second,
			TLSHandshakeTimeout: 10 * time.Second,
		},
		// Redirects are followed by hand so the destination check runs on each hop.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return f, nil
}

// MustNew is New for a compile-time policy; a refused policy is a programming
// error, so it panics rather than return an unbounded Fetcher.
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

// effectivePorts resolves Policy.Ports, defaulting to the allowed schemes' ports.
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
