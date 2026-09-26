package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestTransferDeadline_ProgressingTransferClosedAtLifetimeCap: a peer that
// keeps sending well inside the progress timeout still has its transfer cut
// once the absolute lifetime cap passes. Without the cap, progress would re-arm
// the deadline forever and the body would read to EOF.
func TestTransferDeadline_ProgressingTransferClosedAtLifetimeCap(t *testing.T) {
	const (
		progress = time.Second
		lifetime = 200 * time.Millisecond
		sendFor  = 2 * time.Second
	)

	type result struct {
		err     error
		elapsed time.Duration
	}
	done := make(chan result, 1)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		d := &transferDeadline{ctl: http.NewResponseController(w), timeout: progress, until: start.Add(lifetime)}
		d.touch()
		_, err := io.Copy(io.Discard, progressReader{r: r.Body, d: d})
		done <- result{err: err, elapsed: time.Since(start)}
	}))
	srv.Config.ReadTimeout = progress
	srv.Start()
	defer srv.Close()

	pr, pw := io.Pipe()
	go func() {
		chunk := make([]byte, 1024)
		for stop := time.Now().Add(sendFor); time.Now().Before(stop); {
			if _, err := pw.Write(chunk); err != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		_ = pw.Close()
	}()
	defer pr.Close()

	req, err := http.NewRequest(http.MethodPost, srv.URL, pr)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_ = resp.Body.Close()
		}
	}()

	select {
	case res := <-done:
		if res.err == nil {
			t.Fatalf("progressing transfer ran to EOF after %v; want it cut at the %v lifetime cap", res.elapsed, lifetime)
		}
		if res.elapsed < lifetime {
			t.Fatalf("transfer cut after %v, before the %v lifetime cap: %v", res.elapsed, lifetime, res.err)
		}
	case <-time.After(sendFor + 5*time.Second):
		t.Fatal("handler never returned")
	}
}
