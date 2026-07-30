package admin

import "testing"

// isSetupOriginAllowed guards the first-run setup endpoint, which creates the
// server owner. It had no coverage. The safe default matters most: an empty
// allowlist must deny, not allow.

func TestIsSetupOriginAllowed(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		allowed []string
		want    bool
	}{
		{
			name:    "empty allowlist denies",
			origin:  "https://app.example",
			allowed: nil,
			want:    false,
		},
		{
			name:    "empty allowlist denies even an empty origin",
			origin:  "",
			allowed: nil,
			want:    false,
		},
		{
			name:    "exact match allows",
			origin:  "https://app.example",
			allowed: []string{"https://app.example"},
			want:    true,
		},
		{
			name:    "match is case-insensitive",
			origin:  "https://APP.example",
			allowed: []string{"https://app.example"},
			want:    true,
		},
		{
			name:    "wildcard allows anything",
			origin:  "https://anywhere.example",
			allowed: []string{"*"},
			want:    true,
		},
		{
			name:    "wildcard anywhere in the list allows",
			origin:  "https://anywhere.example",
			allowed: []string{"https://app.example", "*"},
			want:    true,
		},
		{
			name:    "non-matching origin denied",
			origin:  "https://evil.example",
			allowed: []string{"https://app.example"},
			want:    false,
		},
		{
			name:    "match against any list entry",
			origin:  "https://second.example",
			allowed: []string{"https://first.example", "https://second.example"},
			want:    true,
		},
		{
			name:    "a suffix of an allowed origin is not a match",
			origin:  "https://evil-app.example",
			allowed: []string{"https://app.example"},
			want:    false,
		},
		{
			name:    "a prefix of an allowed origin is not a match",
			origin:  "https://app.example.evil.test",
			allowed: []string{"https://app.example"},
			want:    false,
		},
		{
			name:    "scheme must match too",
			origin:  "http://app.example",
			allowed: []string{"https://app.example"},
			want:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isSetupOriginAllowed(tt.origin, tt.allowed); got != tt.want {
				t.Errorf("isSetupOriginAllowed(%q, %v) = %v, want %v",
					tt.origin, tt.allowed, got, tt.want)
			}
		})
	}
}

// isSameOrigin is what lets the admin panel's own setup call through on a
// default config, where allowed_origins is empty. It must not become a hole:
// only an Origin naming this exact host:port may pass.
func TestIsSameOrigin(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		host   string
		want   bool
	}{
		{
			name:   "admin panel on the default port is same-origin",
			origin: "https://localhost:8443",
			host:   "localhost:8443",
			want:   true,
		},
		{
			name:   "host comparison is case-insensitive",
			origin: "https://LocalHost:8443",
			host:   "localhost:8443",
			want:   true,
		},
		{
			name:   "plain http against a proxied host still matches",
			origin: "http://chat.example",
			host:   "chat.example",
			want:   true,
		},
		{
			name:   "a different host is not same-origin",
			origin: "https://evil.example",
			host:   "localhost:8443",
			want:   false,
		},
		{
			name:   "a different port is not same-origin",
			origin: "https://localhost:9999",
			host:   "localhost:8443",
			want:   false,
		},
		{
			name:   "loopback by IP does not match loopback by name",
			origin: "https://127.0.0.1:8443",
			host:   "localhost:8443",
			want:   false,
		},
		{
			name:   "a suffix of the host is not same-origin",
			origin: "https://evil-localhost:8443",
			host:   "localhost:8443",
			want:   false,
		},
		{
			name:   "schemeless origin cannot pass as same-origin",
			origin: "//localhost:8443",
			host:   "localhost:8443",
			want:   false,
		},
		{
			name:   "opaque origin (sandboxed iframe) is denied",
			origin: "null",
			host:   "localhost:8443",
			want:   false,
		},
		{
			name:   "empty origin is denied",
			origin: "",
			host:   "localhost:8443",
			want:   false,
		},
		{
			name:   "empty host denies rather than matching an empty origin host",
			origin: "https://localhost:8443",
			host:   "",
			want:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isSameOrigin(tt.origin, tt.host); got != tt.want {
				t.Errorf("isSameOrigin(%q, %q) = %v, want %v",
					tt.origin, tt.host, got, tt.want)
			}
		})
	}
}
