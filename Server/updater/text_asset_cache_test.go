package updater

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// textAssetServer serves a fixed body at /asset and counts inbound requests.
// handler may be swapped to simulate an upstream outage.
func textAssetServer(t *testing.T, fail *atomic.Bool, hits *atomic.Int64) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/asset", func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		fmt.Fprint(w, "asset-body")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// A burst of concurrent misses must collapse into a single outbound fetch.
// Without singleflight each caller fetches independently (W3-1).
func TestFetchTextAssetCachedCoalescesConcurrentMisses(t *testing.T) {
	var fail atomic.Bool
	var hits atomic.Int64
	srv := textAssetServer(t, &fail, &hits)
	u := newTestUpdater(srv.URL, "1.0.0")

	const callers = 25
	var wg sync.WaitGroup
	results := make([]string, callers)
	errs := make([]error, callers)
	start := make(chan struct{})

	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // release all goroutines together to force a real burst
			results[i], errs[i] = u.FetchTextAssetCached(context.Background(), srv.URL+"/asset")
		}()
	}
	close(start)
	wg.Wait()

	if got := hits.Load(); got != 1 {
		t.Fatalf("outbound fetches = %d, want exactly 1 (singleflight should coalesce)", got)
	}
	for i := range callers {
		if errs[i] != nil {
			t.Fatalf("caller %d: unexpected error: %v", i, errs[i])
		}
		if results[i] != "asset-body" {
			t.Fatalf("caller %d: content = %q, want %q", i, results[i], "asset-body")
		}
	}
}

// A failed fetch must be cached for errorCacheTTL so an upstream outage does
// not produce one outbound request per caller.
func TestFetchTextAssetCachedCachesFailures(t *testing.T) {
	var fail atomic.Bool
	var hits atomic.Int64
	srv := textAssetServer(t, &fail, &hits)
	fail.Store(true)
	u := newTestUpdater(srv.URL, "1.0.0")
	url := srv.URL + "/asset"

	if _, err := u.FetchTextAssetCached(context.Background(), url); err == nil {
		t.Fatal("first call: want error from failing upstream, got nil")
	}
	if _, err := u.FetchTextAssetCached(context.Background(), url); err == nil {
		t.Fatal("second call: want cached error, got nil")
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("outbound fetches = %d, want 1 (the failure should be cached)", got)
	}

	// Once the negative entry expires, the upstream is retried — a cached error
	// must not be permanent.
	u.mu.Lock()
	entry := u.textAssetCache[url]
	entry.expiry = time.Now().Add(-time.Second)
	u.textAssetCache[url] = entry
	u.mu.Unlock()

	fail.Store(false)
	content, err := u.FetchTextAssetCached(context.Background(), url)
	if err != nil {
		t.Fatalf("after negative-cache expiry: unexpected error: %v", err)
	}
	if content != "asset-body" {
		t.Fatalf("content = %q, want %q", content, "asset-body")
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("outbound fetches = %d, want 2 (retry after expiry)", got)
	}
}

// Asset URLs carry a version, so stale keys must be evicted or the map grows by
// one entry per release for the process lifetime.
func TestFetchTextAssetCachedEvictsExpiredKeys(t *testing.T) {
	var fail atomic.Bool
	var hits atomic.Int64
	srv := textAssetServer(t, &fail, &hits)
	u := newTestUpdater(srv.URL, "1.0.0")

	// A superseded entry from an earlier release, already past its expiry.
	u.mu.Lock()
	u.textAssetCache = map[string]textAssetCacheEntry{
		"https://example.invalid/v0.9.0/chatserver.exe.sig": {
			content: "stale",
			expiry:  time.Now().Add(-time.Hour),
		},
	}
	u.mu.Unlock()

	if _, err := u.FetchTextAssetCached(context.Background(), srv.URL+"/asset"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	u.mu.Lock()
	defer u.mu.Unlock()
	if _, ok := u.textAssetCache["https://example.invalid/v0.9.0/chatserver.exe.sig"]; ok {
		t.Fatal("expired key survived a cache write; it should have been evicted")
	}
	if len(u.textAssetCache) != 1 {
		t.Fatalf("cache size = %d, want 1 (only the fresh entry)", len(u.textAssetCache))
	}
}

// A live cached entry must be served without any outbound request.
func TestFetchTextAssetCachedServesFromCache(t *testing.T) {
	var fail atomic.Bool
	var hits atomic.Int64
	srv := textAssetServer(t, &fail, &hits)
	u := newTestUpdater(srv.URL, "1.0.0")
	url := srv.URL + "/asset"

	for range 3 {
		content, err := u.FetchTextAssetCached(context.Background(), url)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if content != "asset-body" {
			t.Fatalf("content = %q, want %q", content, "asset-body")
		}
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("outbound fetches = %d, want 1 (subsequent calls should hit cache)", got)
	}
}
