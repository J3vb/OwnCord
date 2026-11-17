// Package linkpreview stores fetched link cards: the text in SQLite and the shrunk
// thumbnails as content-addressed files under the server data folder.
package linkpreview

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"golang.org/x/net/idna"
)

// ErrInvalidURL marks a link that cannot be previewed: not http or https, no host, or
// carrying credentials.
var ErrInvalidURL = errors.New("invalid link preview url")

// NormalizeURL returns the canonical spelling of a link, the form that is stored, fetched
// and hashed. The rules:
//
//   - only http and https; any other scheme is ErrInvalidURL
//   - the scheme and host are lower-cased, a trailing dot on the host is dropped and a
//     Unicode host is converted to punycode
//   - an IPv6 address with a zone (fe80::1%eth0) is ErrInvalidURL
//   - the port is dropped when it is the scheme's default (80 for http, 443 for https)
//   - an empty path becomes "/"
//   - the fragment is dropped, since a server never sees it
//   - the query is kept exactly as written, order and encoding included, because it can
//     select the page
//   - a link with a user name or password is ErrInvalidURL, so credentials are never
//     stored or fetched
//
// Percent-encoding in the path is kept as written.
func NormalizeURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrInvalidURL, err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("%w: scheme %q", ErrInvalidURL, u.Scheme)
	}
	if u.User != nil {
		return "", fmt.Errorf("%w: credentials in link", ErrInvalidURL)
	}
	host, err := normalizeHost(u.Hostname())
	if err != nil {
		return "", err
	}
	port := u.Port()
	defaultPort := (scheme == "http" && port == "80") || (scheme == "https" && port == "443")
	if port != "" && !defaultPort {
		host += ":" + port
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	out := scheme + "://" + host + path
	if u.ForceQuery || u.RawQuery != "" {
		out += "?" + u.RawQuery
	}
	return out, nil
}

// URLHash is the lower-case hex SHA-256 of the normalised link: the key of a stored card.
// It returns the normalised link as well, which the card stores beside the hash.
func URLHash(raw string) (hash, normalized string, err error) {
	normalized, err = NormalizeURL(raw)
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:]), normalized, nil
}

// normalizeHost lower-cases a host, drops its trailing dot, converts a name to punycode and
// brackets an IPv6 literal.
func normalizeHost(h string) (string, error) {
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	switch {
	case h == "":
		return "", fmt.Errorf("%w: no host", ErrInvalidURL)
	case strings.Contains(h, "%"):
		return "", fmt.Errorf("%w: zone in host", ErrInvalidURL)
	case strings.Contains(h, ":"):
		return "[" + h + "]", nil
	}
	if isASCII(h) {
		// Plain ASCII hosts skip IDNA, whose rules refuse names real sites use (underscores).
		return h, nil
	}
	ascii, err := idna.Lookup.ToASCII(h)
	if err != nil || ascii == "" {
		return "", fmt.Errorf("%w: host %q", ErrInvalidURL, h)
	}
	return ascii, nil
}

func isASCII(s string) bool {
	for i := range len(s) {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}
