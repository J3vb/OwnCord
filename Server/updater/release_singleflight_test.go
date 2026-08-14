package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

// A burst of concurrent CheckForUpdate calls against an expired/cold release
// cache must collapse into a single outbound GitHub fetch. Without
// singleflight, every caller that observes the cache as expired issues its
// own outbound request (OC-0146).
func TestCheckForUpdateCoalescesConcurrentMisses(t *testing.T) {
	var hits atomic.Int64
	release := newTestRelease("v2.0.0", "Major update", "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
		"https://github.com/J3vb/OwnCord/releases/download/v2.0.0")

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/J3vb/OwnCord/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(release); err != nil {
			t.Fatalf("encoding release: %v", err)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")

	const callers = 25
	var wg sync.WaitGroup
	errs := make([]error, callers)
	start := make(chan struct{})

	for i := range callers {
		wg.Go(func() {
			<-start // release all goroutines together to force a real burst
			_, errs[i] = u.CheckForUpdate(context.Background())
		})
	}
	close(start)
	wg.Wait()

	for i := range callers {
		if errs[i] != nil {
			t.Fatalf("caller %d: unexpected error: %v", i, errs[i])
		}
	}

	if got := hits.Load(); got != 1 {
		t.Fatalf("outbound fetches = %d, want exactly 1 (singleflight should coalesce)", got)
	}
}
