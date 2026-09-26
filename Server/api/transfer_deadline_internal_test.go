package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// progressingUploadResult is what the server-side handler saw.
type progressingUploadResult struct {
	err     error
	elapsed time.Duration
}

// runProgressingUpload serves one request whose body arrives in small chunks
// every 5 ms for sendFor, reading it through a progressReader over the
// deadline start returns, and reports how the handler's read ended.
func runProgressingUpload(t *testing.T, readTimeout, sendFor time.Duration, start func(http.ResponseWriter) *transferDeadline) progressingUploadResult {
	t.Helper()
	done := make(chan progressingUploadResult, 1)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		begin := time.Now()
		d := start(w)
		defer d.release()
		d.touch()
		_, err := io.Copy(io.Discard, progressReader{r: r.Body, d: d})
		done <- progressingUploadResult{err: err, elapsed: time.Since(begin)}
	}))
	srv.Config.ReadTimeout = readTimeout
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
		return res
	case <-time.After(sendFor + 5*time.Second):
		t.Fatal("handler never returned")
		return progressingUploadResult{}
	}
}

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
	res := runProgressingUpload(t, progress, sendFor, func(w http.ResponseWriter) *transferDeadline {
		return startTransfer(w, progress, lifetime)
	})
	if res.err == nil {
		t.Fatalf("progressing transfer ran to EOF after %v; want it cut at the %v lifetime cap", res.elapsed, lifetime)
	}
	if res.elapsed < lifetime {
		t.Fatalf("transfer cut after %v, before the %v lifetime cap: %v", res.elapsed, lifetime, res.err)
	}
}

// TestTransferDeadline_ProgressingTransferCutAtShutdown: the shutdown hook
// CancelInFlightTransfers cuts a transfer that is still making progress and is far
// inside its lifetime cap, so a graceful drain is not held open by it.
func TestTransferDeadline_ProgressingTransferCutAtShutdown(t *testing.T) {
	const (
		progress   = time.Second
		lifetime   = time.Minute
		sendFor    = 2 * time.Second
		shutdownAt = 200 * time.Millisecond
	)
	res := runProgressingUpload(t, progress, sendFor, func(w http.ResponseWriter) *transferDeadline {
		d := startTransfer(w, progress, lifetime)
		time.AfterFunc(shutdownAt, CancelInFlightTransfers)
		return d
	})
	if res.err == nil {
		t.Fatalf("progressing transfer ran to EOF after %v; want it cut at shutdown", res.elapsed)
	}
	if res.elapsed >= sendFor {
		t.Fatalf("transfer ended after %v, not at shutdown (%v): %v", res.elapsed, shutdownAt, res.err)
	}
}
