package safefetch

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// destination is one validated hop: the URL as parsed, and the concrete
// addresses the dial is allowed to use. Nothing else may be dialled, and the
// host is never resolved again — that second lookup is the DNS-rebinding
// window this type exists to close.
type destination struct {
	url   *url.URL
	host  string
	port  string
	addrs []netip.Addr
}

// vettedKey carries a *destination from Fetcher.follow to Fetcher.dial. The
// dial fails closed when it is absent: a dial the policy did not authorise is
// a bug, not a fallback.
type vettedKey struct{}

// destination parses, screens and resolves raw, returning the only addresses
// this hop may connect to. allowHost is the caller's own host rule and may be
// nil; it runs before the resolver, so a host the caller refuses costs no DNS.
func (f *Fetcher) destination(ctx context.Context, raw string, allowHost func(string) bool) (*destination, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidURL, err)
	}
	if u.User != nil {
		return nil, fmt.Errorf("%w: %s", ErrCredentialsInURL, u.Redacted())
	}
	scheme := strings.ToLower(u.Scheme)
	if !slices.Contains(f.policy.Schemes, scheme) {
		return nil, fmt.Errorf("%w: %q", ErrBlockedScheme, u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return nil, fmt.Errorf("%w: %q has no host", ErrInvalidURL, raw)
	}
	port, err := f.hopPort(u, scheme)
	if err != nil {
		return nil, err
	}
	if allowHost != nil && !allowHost(net.JoinHostPort(host, port)) {
		return nil, fmt.Errorf("%w: %s", ErrHostNotAllowed, net.JoinHostPort(host, port))
	}
	addrs, err := f.addresses(ctx, host)
	if err != nil {
		return nil, err
	}
	return &destination{url: u, host: host, port: port, addrs: addrs}, nil
}

// hopPort returns the destination port as a string, refusing anything off the
// policy's port allowlist.
func (f *Fetcher) hopPort(u *url.URL, scheme string) (string, error) {
	port := u.Port()
	if port == "" {
		if scheme == "http" {
			port = "80"
		} else {
			port = "443"
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		return "", fmt.Errorf("%w: port %q", ErrInvalidURL, port)
	}
	if !slices.Contains(f.ports, n) {
		return "", fmt.Errorf("%w: %d", ErrBlockedPort, n)
	}
	return port, nil
}

// addresses resolves host and refuses the whole request if any answer is
// non-global. An IP literal is classified directly and never resolved, so
// there is no way to reach a blocked address by skipping DNS.
func (f *Fetcher) addresses(ctx context.Context, host string) ([]netip.Addr, error) {
	if literal, err := netip.ParseAddr(host); err == nil {
		if err := f.classify(literal); err != nil {
			return nil, err
		}
		return []netip.Addr{literal}, nil
	}
	addrs, err := f.resolve(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("%w %s: %w", ErrResolve, host, err)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrNoAddresses, host)
	}
	// Every answer, not the first that works: one poisoned record among ten
	// refuses the request, or the attacker just retries until ordering
	// favours them.
	for _, a := range addrs {
		if err := f.classify(a); err != nil {
			return nil, fmt.Errorf("%s: %w", host, err)
		}
	}
	return slices.Clone(addrs), nil
}

// dial is the transport's only way out. It connects to the addresses the
// policy already vetted for this hop and to nothing else: the hostname never
// reaches a resolver here, so a DNS answer that changes after validation
// cannot move the connection.
func (f *Fetcher) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	dest, ok := ctx.Value(vettedKey{}).(*destination)
	if !ok || dest == nil {
		return nil, fmt.Errorf("%w: dial to %s with no validated destination", ErrBlockedAddress, addr)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidURL, err)
	}
	if !strings.EqualFold(host, dest.host) || port != dest.port {
		return nil, fmt.Errorf("%w: dial to %s, but %s was validated",
			ErrBlockedAddress, addr, net.JoinHostPort(dest.host, dest.port))
	}
	var lastErr error
	for _, a := range dest.addrs {
		// Re-classified immediately before the connect. The list cannot have
		// changed, which is the point: this asserts it.
		if err := f.classify(a); err != nil {
			return nil, err
		}
		conn, err := f.dialer(ctx, network, net.JoinHostPort(a.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}
