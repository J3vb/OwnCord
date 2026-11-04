package livekitproc

import "testing"

func TestHTTPURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"ws to http", "ws://localhost:7880", "http://localhost:7880"},
		{"wss to https", "wss://livekit.example.com", "https://livekit.example.com"},
		{"http passthrough", "http://localhost:7880", "http://localhost:7880"},
		{"https passthrough", "https://livekit.example.com", "https://livekit.example.com"},
		{"empty string", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := HTTPURL(tt.in)
			if got != tt.want {
				t.Errorf("HTTPURL(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
