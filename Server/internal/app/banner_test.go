package app

import "testing"

// The banner's URLs must stay valid on an IPv6-only host: the address is
// bracketed before the port (a Codex finding on #1510).
func TestWSURL_BracketsIPv6(t *testing.T) {
	cases := []struct{ scheme, ip, want string }{
		{"http", "192.0.2.10", "ws://192.0.2.10:8080"},
		{"https", "2001:db8::1", "wss://[2001:db8::1]:8080"},
		{"https", "localhost", "wss://localhost:8080"},
	}
	for _, tc := range cases {
		if got := wsURL(tc.scheme, tc.ip, 8080); got != tc.want {
			t.Errorf("wsURL(%s, %s) = %q, want %q", tc.scheme, tc.ip, got, tc.want)
		}
	}
}
