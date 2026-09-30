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
func runProgressingUpload(t *testing.T, readTimeout, sendFor time.Duration, start func(http.ResponseWriter, *http.Request) *transferDeadline) progressingUploadResult {
	t.Helper()
	done := make(chan progressingUploadResult, 1)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		begin := time.Now()
		d := start(w, r)
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
	res := runProgressingUpload(t, progress, sendFor, func(w http.ResponseWriter, r *http.Request) *transferDeadline {
		return startTransfer(w, r, progress, lifetime)
	})
	if res.err == nil {
		t.Fatalf("progressing transfer ran to EOF after %v; want it cut at the %v lifetime cap", res.elapsed, lifetime)
	}
	if res.elapsed < lifetime {
		t.Fatalf("transfer cut after %v, before the %v lifetime cap: %v", res.elapsed, lifetime, res.err)
	}
}

// TestTransferDeadline_TricklingTransferCutWithinShutdownGrace: a transfer
// still making progress, and far inside its lifetime cap, is cut once the
// shutdown grace runs out, so a graceful drain is not held open by it.
func TestTransferDeadline_TricklingTransferCutWithinShutdownGrace(t *testing.T) {
	const (
		progress   = time.Second
		lifetime   = time.Minute
		sendFor    = 2 * time.Second
		shutdownAt = 100 * time.Millisecond
		grace      = 200 * time.Millisecond
	)
	res := runProgressingUpload(t, progress, sendFor, func(w http.ResponseWriter, r *http.Request) *transferDeadline {
		d := startTransfer(w, r, progress, lifetime)
		time.AfterFunc(shutdownAt, shutdownTransfers(serverOf(r), grace))
		return d
	})
	if res.err == nil {
		t.Fatalf("trickling transfer ran to EOF after %v; want it cut at the shutdown grace", res.elapsed)
	}
	if res.elapsed < shutdownAt+grace || res.elapsed >= sendFor {
		t.Fatalf("transfer ended after %v, want it cut about %v after shutdown began at %v: %v", res.elapsed, grace, shutdownAt, res.err)
	}
}

// TestTransferDeadline_ShortTransferFinishesDuringShutdown: a transfer that
// completes inside the shutdown grace is not cut by shutdown.
func TestTransferDeadline_ShortTransferFinishesDuringShutdown(t *testing.T) {
	const (
		progress   = time.Second
		lifetime   = time.Minute
		sendFor    = 300 * time.Millisecond
		shutdownAt = 100 * time.Millisecond
		grace      = 2 * time.Second
	)
	res := runProgressingUpload(t, progress, sendFor, func(w http.ResponseWriter, r *http.Request) *transferDeadline {
		d := startTransfer(w, r, progress, lifetime)
		time.AfterFunc(shutdownAt, shutdownTransfers(serverOf(r), grace))
		return d
	})
	if res.err != nil {
		t.Fatalf("short transfer cut by shutdown after %v: %v", res.elapsed, res.err)
	}
}

// TestTransferDeadline_TransferStartingAfterShutdownIsCut: a request already
// past its headers when shutdown begins reaches the transfer handler after the
// hook has run; its transfer must still end by the shutdown grace, not be
// given the full lifetime.
func TestTransferDeadline_TransferStartingAfterShutdownIsCut(t *testing.T) {
	const (
		progress = time.Second
		lifetime = time.Minute
		sendFor  = 2 * time.Second
		grace    = 200 * time.Millisecond
	)
	res := runProgressingUpload(t, progress, sendFor, func(w http.ResponseWriter, r *http.Request) *transferDeadline {
		shutdownTransfers(serverOf(r), grace)()
		return startTransfer(w, r, progress, lifetime)
	})
	if res.err == nil {
		t.Fatalf("transfer started after shutdown ran to EOF after %v; want it cut at the shutdown grace", res.elapsed)
	}
	if res.elapsed >= progress {
		t.Fatalf("transfer started after shutdown ran for %v before it was cut: %v", res.elapsed, res.err)
	}
}

// TestTransferDeadline_ShutdownLeavesOtherServersAlone: one server's shutdown
// hook must not cut a transfer another server in the same process starts.
func TestTransferDeadline_ShutdownLeavesOtherServersAlone(t *testing.T) {
	const (
		progress = time.Second
		lifetime = time.Minute
		sendFor  = 300 * time.Millisecond
	)
	shutdownTransfers(&http.Server{}, 0)()
	res := runProgressingUpload(t, progress, sendFor, func(w http.ResponseWriter, r *http.Request) *transferDeadline {
		return startTransfer(w, r, progress, lifetime)
	})
	if res.err != nil {
		t.Fatalf("transfer on a live server cut after %v by another server's shutdown: %v", res.elapsed, res.err)
	}
}

func serverOf(r *http.Request) *http.Server {
	srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
	return srv
}
