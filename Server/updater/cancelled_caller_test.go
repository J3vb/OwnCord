package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// The release and text-asset caches are process-wide and shared by the
// unauthenticated client-update endpoint and the owner-only admin handlers, so
// a caller that cancels its request must never leave a failure behind for the
// next caller. An already-cancelled context stands in for a client that aborts
// its connection mid-flight: both surface as context.Canceled out of the
// outbound fetch.

func TestCheckForUpdateCancelledCallerDoesNotPoisonCache(t *testing.T) {
	release := newTestRelease("v1.2.0", "notes", "https://github.com/J3vb/OwnCord/releases/tag/v1.2.0",
		"https://github.com/J3vb/OwnCord/releases/download/v1.2.0")

	var hits atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/J3vb/OwnCord/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(release)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	// Outcome for the aborted caller itself is deliberately not asserted; what
	// matters is what it leaves in the shared cache.
	_, _ = u.CheckForUpdate(cancelled)

	info, err := u.CheckForUpdate(context.Background())
	if err != nil {
		t.Fatalf("second caller got a poisoned cache: %v", err)
	}
	if info.Latest != "v1.2.0" {
		t.Fatalf("Latest = %q, want %q", info.Latest, "v1.2.0")
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("outbound fetches = %d, want 1 (upstream consulted once, result cached)", got)
	}
}

func TestFetchTextAssetCachedCancelledCallerDoesNotPoisonCache(t *testing.T) {
	var fail atomic.Bool
	var hits atomic.Int64
	srv := textAssetServer(t, &fail, &hits)
	u := newTestUpdater(srv.URL, "1.0.0")
	url := srv.URL + "/asset"

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, _ = u.FetchTextAssetCached(cancelled, url)

	content, err := u.FetchTextAssetCached(context.Background(), url)
	if err != nil {
		t.Fatalf("second caller got a poisoned cache: %v", err)
	}
	if content != "asset-body" {
		t.Fatalf("content = %q, want %q", content, "asset-body")
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("outbound fetches = %d, want 1 (upstream consulted once, result cached)", got)
	}
}
