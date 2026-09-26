package safefetch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"strings"
)

// Request is one outbound fetch. Method defaults to GET.
type Request struct {
	Method string
	URL    string
	Body   []byte
	Header map[string]string

	// AllowHost, when set, is consulted for the "host:port" of every hop,
	// the first one included, and the fetch is refused if it says no. It is
	// how a caller layers its own destination rule on top of the address
	// policy — the plugin `http` capability's operator host allowlist is the
	// one caller that has one.
	//
	// It is per-request rather than per-Policy so that one process-wide
	// Fetcher, and therefore one process-wide concurrency cap, can serve
	// callers whose host rules differ.
	AllowHost func(hostport string) bool
}

// Response is a bounded, type-checked reply.
//
// Body is already inflated and already inside both ceilings, so Header's
// Content-Encoding is removed and its Content-Length restated to match what
// Body actually holds — a caller that trusted the upstream values would be
// describing a body that no longer exists.
type Response struct {
	StatusCode  int
	Header      http.Header
	Body        []byte
	ContentType string // declared media type, lowercased, parameters stripped
	SniffedType string // what the first bytes of Body actually look like; "" when Body is empty
	FinalURL    string // where Body came from, after any redirects
}

// hop is the request as it stands at one point in a redirect chain.
type hop struct {
	method string
	url    string
	body   []byte
	header map[string]string
}

// Fetch performs one bounded fetch, following at most Policy.MaxRedirects
// redirects by hand.
func (f *Fetcher) Fetch(ctx context.Context, req Request) (*Response, error) {
	ctx, cancel := context.WithTimeout(ctx, f.policy.Deadline)
	defer cancel()

	// Two gates: this Fetcher's cap, then the process-wide one. Always in
	// that order, so two Fetchers can never hold each other's slots.
	if err := f.gate.acquire(ctx); err != nil {
		return nil, fmt.Errorf("safefetch: waiting for a slot: %w", err)
	}
	defer f.gate.release()
	if err := processGate.acquire(ctx); err != nil {
		return nil, fmt.Errorf("safefetch: waiting for a process slot: %w", err)
	}
	defer processGate.release()

	return f.follow(ctx, req)
}

// follow walks the redirect chain, re-running the whole destination check on
// every hop.
func (f *Fetcher) follow(ctx context.Context, req Request) (*Response, error) {
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	cur := hop{method: method, url: req.URL, body: req.Body, header: maps.Clone(req.Header)}
	var prev *url.URL
	for hops := 0; ; hops++ {
		dest, err := f.destination(ctx, cur.url, req.AllowHost)
		if err != nil {
			return nil, err
		}
		if prev != nil {
			if err := checkNoDowngrade(prev.Scheme, dest.url.Scheme); err != nil {
				return nil, err
			}
		}
		done, next, err := f.step(ctx, dest, cur, hops)
		if err != nil || done != nil {
			return done, err
		}
		if next == nil {
			// Unreachable: step returns a response, an error, or a next hop.
			// Spelled out because the alternative is a nil dereference inside
			// an unbounded loop.
			return nil, fmt.Errorf("safefetch: no response and no next hop for %s", dest.url.Redacted())
		}
		prev, cur = dest.url, *next
	}
}

// step performs one request. It returns either a finished Response or the
// next hop, and closes the response body on every path.
func (f *Fetcher) step(ctx context.Context, dest *destination, cur hop, hops int) (*Response, *hop, error) {
	resp, err := f.roundTrip(ctx, dest, cur)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if !isRedirect(resp.StatusCode) {
		done, err := f.readResponse(ctx, resp, dest)
		return done, nil, err
	}
	location := resp.Header.Get("Location")
	if location == "" {
		return nil, nil, fmt.Errorf("%w: %d from %s", ErrRedirectWithoutLocation, resp.StatusCode, dest.url.Redacted())
	}
	// Drain a little so the connection can be reused, but never the whole
	// body: a redirect's body is not content anyone asked for.
	_, _ = io.CopyN(io.Discard, resp.Body, 4<<10)
	if hops >= f.policy.MaxRedirects {
		return nil, nil, fmt.Errorf("%w: budget is %d", ErrTooManyRedirects, f.policy.MaxRedirects)
	}
	target, err := dest.url.Parse(location)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: bad Location: %w", ErrInvalidURL, err)
	}
	next := nextHop(cur, dest.url, target, resp.StatusCode)
	return nil, &next, nil
}

// roundTrip issues one request against the already-validated destination.
func (f *Fetcher) roundTrip(ctx context.Context, dest *destination, cur hop) (*http.Response, error) {
	var body io.Reader
	if len(cur.body) > 0 {
		body = bytes.NewReader(cur.body)
	}
	req, err := http.NewRequestWithContext(context.WithValue(ctx, vettedKey{}, dest), cur.method, dest.url.String(), body)
	if err != nil {
		return nil, fmt.Errorf("safefetch: build request: %w", err)
	}
	for k, v := range cur.header {
		req.Header.Set(k, v)
	}
	// We manage compression ourselves so the wire ceiling sees wire bytes;
	// the caller does not get to change that.
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := f.client.Do(req) //nolint:bodyclose // step() closes it
	if err != nil {
		return nil, wrapContext(ctx, fmt.Errorf("safefetch: %w", err))
	}
	return resp, nil
}

// isRedirect lists the statuses this package follows. 300 and 304 are not
// among them: neither names a single destination to fetch instead.
func isRedirect(status int) bool {
	switch status {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

// checkNoDowngrade refuses a hop that moves from https to a weaker scheme.
// Following one would hand an on-path attacker the rest of the chain.
func checkNoDowngrade(from, to string) error {
	if strings.EqualFold(from, "https") && !strings.EqualFold(to, "https") {
		return fmt.Errorf("%w: %s -> %s", ErrSchemeDowngrade, from, to)
	}
	return nil
}

// nextHop applies the method and header rules for a redirect: 301, 302 and
// 303 turn a body-carrying request into a GET, 307 and 308 keep it, and
// credentials never cross an origin.
func nextHop(cur hop, from, to *url.URL, status int) hop {
	next := hop{method: cur.method, url: to.String(), body: cur.body, header: maps.Clone(cur.header)}
	if status != http.StatusTemporaryRedirect && status != http.StatusPermanentRedirect {
		next.body = nil
		if cur.method != http.MethodGet && cur.method != http.MethodHead {
			next.method = http.MethodGet
		}
	}
	if sameOrigin(from, to) {
		return next
	}
	for _, h := range []string{"Authorization", "Www-Authenticate", "Cookie", "Cookie2", "Proxy-Authorization"} {
		for k := range next.header {
			if strings.EqualFold(k, h) {
				delete(next.header, k)
			}
		}
	}
	return next
}

// sameOrigin compares scheme, host and port. Port is deliberately part of it:
// a different port is a different service, and net/http's own hostname-only
// comparison would carry an Authorization header to it.
func sameOrigin(a, b *url.URL) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) &&
		strings.EqualFold(a.Hostname(), b.Hostname()) &&
		portOf(a) == portOf(b)
}

func portOf(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	if strings.EqualFold(u.Scheme, "http") {
		return "80"
	}
	return "443"
}

// wrapContext reports a cancelled or expired context as such. The transport
// wraps its own error around the context error inconsistently between the
// connect, the header read and the body read; a caller that wants to tell
// "we ran out of time" from "upstream misbehaved" needs one answer.
func wrapContext(ctx context.Context, err error) error {
	if cause := ctx.Err(); cause != nil && !errors.Is(err, cause) {
		return fmt.Errorf("safefetch: %w (%w)", cause, err)
	}
	return err
}
