package api_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
)

// countKlipy is stubKlipy that counts upstream calls.
func countKlipy(t *testing.T) *atomic.Int32 {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(gifUpstreamBody))
	}))
	t.Cleanup(srv.Close)
	restore, err := api.SetGIFUpstreamForTest(srv.URL)
	if err != nil {
		t.Fatalf("SetGIFUpstreamForTest: %v", err)
	}
	t.Cleanup(restore)
	return &hits
}

// Trending is the same for everyone for a while: two picker opens inside the
// window cost one upstream call and get the same page. A different page size
// is its own entry.
func TestGIFTrendingIsCachedBriefly(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "giftrend", 4)
	hits := countKlipy(t)
	router := buildGIFRouter(database, "server-side-key")

	first := gifGET(t, router, "/api/v1/gif/trending", token)
	second := gifGET(t, router, "/api/v1/gif/trending", token)
	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("status = %d, %d", first.Code, second.Code)
	}
	if first.Body.String() != second.Body.String() {
		t.Errorf("cached page differs:\n%s\n%s", first.Body.String(), second.Body.String())
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream hit %d times, want 1", got)
	}
	if rr := gifGET(t, router, "/api/v1/gif/trending?limit=5", token); rr.Code != http.StatusOK || hits.Load() != 2 {
		t.Fatalf("another limit: %d, hits %d, want its own upstream call", rr.Code, hits.Load())
	}
}

// Search answers are per term and stay live.
func TestGIFSearchIsNotCached(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifsearch", 4)
	hits := countKlipy(t)
	router := buildGIFRouter(database, "server-side-key")
	for range 2 {
		if rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token); rr.Code != http.StatusOK {
			t.Fatalf("status = %d", rr.Code)
		}
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("upstream hit %d times, want 2", got)
	}
}

// A failed trending call is not kept: the next open asks again.
func TestGIFTrendingFailureIsNotCached(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "giftrendfail", 4)
	stubKlipy(t, `{}`, http.StatusInternalServerError)
	router := buildGIFRouter(database, "server-side-key")
	if rr := gifGET(t, router, "/api/v1/gif/trending", token); rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
	hits := countKlipy(t)
	if rr := gifGET(t, router, "/api/v1/gif/trending", token); rr.Code != http.StatusOK || hits.Load() != 1 {
		t.Fatalf("after a failure: %d, hits %d, want a fresh upstream call", rr.Code, hits.Load())
	}
}
