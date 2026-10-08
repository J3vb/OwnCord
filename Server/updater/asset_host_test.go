package updater

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// countingServer answers 200 at every path and counts the requests it sees.
func countingServer(t *testing.T, hits *atomic.Int64) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("body"))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// Asset URLs come from the release JSON, so an asset fetch reaches only an
// https GitHub host: any other URL is refused before a request is sent.
func TestFetchTextAsset_RefusesNonGitHubHost(t *testing.T) {
	var hits atomic.Int64
	srv := countingServer(t, &hits)
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")

	if _, err := u.FetchTextAsset(context.Background(), srv.URL+"/asset.sig"); err == nil {
		t.Error("FetchTextAsset of a non-GitHub URL succeeded, want an error")
	}
	if got := hits.Load(); got != 0 {
		t.Errorf("non-GitHub host received %d requests, want 0", got)
	}
}

// A redirect is held to the same host check as the first request.
func TestFetchTextAsset_RefusesRedirectOffHost(t *testing.T) {
	var offHits atomic.Int64
	off := countingServer(t, &offHits)
	srv := httptest.NewServer(http.RedirectHandler(off.URL+"/asset.sig", http.StatusFound))
	t.Cleanup(srv.Close)
	u := newTestUpdater(srv.URL, "1.0.0")

	if _, err := u.FetchTextAsset(context.Background(), srv.URL+"/asset.sig"); err == nil {
		t.Error("FetchTextAsset followed a redirect off the allowed hosts, want an error")
	}
	if got := offHits.Load(); got != 0 {
		t.Errorf("redirect target received %d requests, want 0", got)
	}
}

func TestTrustedURL(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.baseURL = "http://127.0.0.1:4123"
	tests := []struct {
		url  string
		want bool
	}{
		{"https://github.com/J3vb/OwnCord/releases/download/v1/a.sig", true},
		{"https://objects.githubusercontent.com/asset", true},
		{"https://release-assets.githubusercontent.com/asset", true},
		{"http://github.com/J3vb/OwnCord/releases/download/v1/a.sig", false},
		{"https://evil.example/asset", false},
		{"http://127.0.0.1:4123/asset", true},
		{"http://127.0.0.1:41234/asset", false},
	}
	for _, tc := range tests {
		if got := u.trustedURL(tc.url); got != tc.want {
			t.Errorf("trustedURL(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestNewUpdater_SetsRedirectHostCheck(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	if u.httpClient.CheckRedirect == nil {
		t.Error("httpClient.CheckRedirect is nil, want the host check")
	}
}
