package updater

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A download that keeps making progress must outlive the metadata client's
// whole-exchange timeout.
func TestDownloadFile_SlowButProgressingSurvivesMetadataTimeout(t *testing.T) {
	const chunks = 8
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		for range chunks {
			_, _ = w.Write([]byte("0123456789"))
			w.(http.Flusher).Flush()
			time.Sleep(50 * time.Millisecond)
		}
	}))
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	u.httpClient = &http.Client{Timeout: 100 * time.Millisecond}
	u.downloadStallTimeout = 2 * time.Second

	dest := filepath.Join(t.TempDir(), "asset")
	start := time.Now()
	if err := u.downloadFile(context.Background(), srv.URL+"/asset", dest); err != nil {
		t.Fatalf("downloadFile: %v", err)
	}
	if time.Since(start) <= u.httpClient.Timeout {
		t.Fatalf("test did not outlast the metadata timeout")
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if len(got) != chunks*10 {
		t.Errorf("downloaded %d bytes, want %d", len(got), chunks*10)
	}
}

// A connection that goes silent mid-body is abandoned by the stall timeout and
// leaves no partial file behind.
func TestDownloadFile_StalledBodyIsAbandoned(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	u := newTestUpdater(srv.URL, "1.0.0")
	u.downloadStallTimeout = 150 * time.Millisecond

	dest := filepath.Join(t.TempDir(), "asset")
	start := time.Now()
	err := u.downloadFile(context.Background(), srv.URL+"/asset", dest)
	if !errors.Is(err, errDownloadStalled) {
		t.Fatalf("err = %v, want errDownloadStalled", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("stall took %v to abandon", elapsed)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Errorf("partial file left behind: %v", statErr)
	}
}

// The caller's context deadline still bounds a download that keeps trickling.
func TestDownloadFile_CallerDeadlineStillBounds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		for r.Context().Err() == nil {
			_, _ = w.Write([]byte("x"))
			w.(http.Flusher).Flush()
			time.Sleep(20 * time.Millisecond)
		}
	}))
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	u.downloadStallTimeout = 2 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	err := u.downloadFile(ctx, srv.URL+"/asset", filepath.Join(t.TempDir(), "asset"))
	if !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errDownloadStalled) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
}

// The metadata client keeps its short whole-exchange bound and a response
// header timeout; the download client drops only the former.
func TestDownloadHTTPClient_OnlyDropsWholeExchangeTimeout(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	if u.httpClient.Timeout != metadataClientTimeout {
		t.Errorf("metadata Timeout = %v, want %v", u.httpClient.Timeout, metadataClientTimeout)
	}
	d := u.downloadHTTPClient()
	if d.Timeout != 0 {
		t.Errorf("download Timeout = %v, want 0", d.Timeout)
	}
	if d.CheckRedirect == nil {
		t.Error("download client lost the redirect host check")
	}
	tr, ok := d.Transport.(*http.Transport)
	if !ok || tr.ResponseHeaderTimeout != responseHeaderTimeout {
		t.Errorf("download transport lacks ResponseHeaderTimeout")
	}
}

// A server that accepts the request and never sends headers is abandoned by
// the transport's response-header timeout.
func TestDownloadFile_NoHeadersIsAbandoned(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	u := newTestUpdater(srv.URL, "1.0.0")
	tr, ok := NewUpdater("1.0.0", "", "J3vb", "OwnCord").httpClient.Transport.(*http.Transport)
	if !ok {
		t.Fatal("updater transport is not an *http.Transport")
	}
	tr.ResponseHeaderTimeout = 100 * time.Millisecond
	u.httpClient = &http.Client{Transport: tr, Timeout: metadataClientTimeout}

	dest := filepath.Join(t.TempDir(), "asset")
	start := time.Now()
	if err := u.downloadFile(context.Background(), srv.URL+"/asset", dest); err == nil {
		t.Fatal("downloadFile succeeded against a server that sent no headers")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("took %v to abandon, want about 100ms", elapsed)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Errorf("dest file exists: %v", statErr)
	}
}
