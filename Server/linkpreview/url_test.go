package linkpreview

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
)

func TestNormalizeURL(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"lowercases scheme and host", "HTTPS://Example.COM/Path", "https://example.com/Path"},
		{"drops fragment", "https://example.com/a#section", "https://example.com/a"},
		{"keeps query as written", "https://example.com/a?b=2&a=1", "https://example.com/a?b=2&a=1"},
		{"keeps query with fragment dropped", "https://example.com/a?x=1#frag", "https://example.com/a?x=1"},
		{"empty path becomes slash", "https://example.com", "https://example.com/"},
		{"empty path with query", "https://example.com?q=1", "https://example.com/?q=1"},
		{"drops default https port", "https://example.com:443/a", "https://example.com/a"},
		{"drops default http port", "http://example.com:80/a", "http://example.com/a"},
		{"keeps other port", "https://example.com:8443/a", "https://example.com:8443/a"},
		{"keeps http on 443", "http://example.com:443/a", "http://example.com:443/a"},
		{"keeps path encoding", "https://example.com/a%2Fb%20c", "https://example.com/a%2Fb%20c"},
		{"trims surrounding space", "  https://example.com/a \n", "https://example.com/a"},
		{"ipv6 host", "http://[::1]:8080/x", "http://[::1]:8080/x"},
		{"keeps trailing slash", "https://example.com/a/", "https://example.com/a/"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeURL(tc.in)
			if err != nil {
				t.Fatalf("NormalizeURL(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("NormalizeURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
			again, err := NormalizeURL(got)
			if err != nil || again != got {
				t.Errorf("NormalizeURL is not idempotent: %q -> %q (%v)", got, again, err)
			}
		})
	}
}

func TestNormalizeURLRejects(t *testing.T) {
	for _, in := range []string{
		"", "example.com/a", "ftp://example.com/a", "javascript:alert(1)", "file:///etc/passwd",
		"https:///nohost", "https://user:pw@example.com/", "https://user@example.com/", "http://%zz/",
	} {
		t.Run(in, func(t *testing.T) {
			if got, err := NormalizeURL(in); !errors.Is(err, ErrInvalidURL) {
				t.Errorf("NormalizeURL(%q) = %q, %v; want ErrInvalidURL", in, got, err)
			}
		})
	}
}

func TestURLHash(t *testing.T) {
	a, na, err := URLHash("HTTPS://Example.com:443/p#x")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := URLHash("https://example.com/p")
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Errorf("equivalent links hash differently: %s vs %s", a, b)
	}
	sum := sha256.Sum256([]byte("https://example.com/p"))
	if want := hex.EncodeToString(sum[:]); a != want || na != "https://example.com/p" {
		t.Errorf("URLHash = %s, %q; want %s, normalised form", a, na, want)
	}
	if !ValidHash(a) {
		t.Errorf("URLHash %q is not a valid hash", a)
	}
	c, _, _ := URLHash("https://example.com/p?x=1")
	if c == a {
		t.Error("a query must change the hash")
	}
	if _, _, err := URLHash("ftp://x/"); !errors.Is(err, ErrInvalidURL) {
		t.Errorf("URLHash(ftp) err = %v, want ErrInvalidURL", err)
	}
}
