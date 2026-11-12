package admin

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

func TestComputeRestartURL_HostForms(t *testing.T) {
	running := &config.Config{}
	running.Server.Port = 8080
	running.TLS.Mode = "self-signed"
	port := 8443
	wr := &setupWizardRequest{Port: &port}

	tests := []struct{ host, want string }{
		{"[::1]", "https://[::1]:8443/admin"},
		{"[2001:db8::1]", "https://[2001:db8::1]:8443/admin"},
		{"[::1]:8080", "https://[::1]:8443/admin"},
		{"192.0.2.7", "https://192.0.2.7:8443/admin"},
		{"192.0.2.7:8080", "https://192.0.2.7:8443/admin"},
		{"chat.example.com", "https://chat.example.com:8443/admin"},
		{"chat.example.com:443", "https://chat.example.com:8443/admin"},
	}
	for _, tc := range tests {
		if got := computeRestartURL(tc.host, wr, running); got != tc.want {
			t.Errorf("computeRestartURL(%q) = %q, want %q", tc.host, got, tc.want)
		}
	}
}
