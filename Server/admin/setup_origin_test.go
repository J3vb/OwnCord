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
