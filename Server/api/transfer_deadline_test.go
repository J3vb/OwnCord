package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// SRV-05 at the HTTP seam: the server's global ReadTimeout/WriteTimeout (30 s
// in production) bound the WHOLE request, so a transfer that needs longer than
// that is cut mid-body even though it keeps making progress. These tests run
// against a real http.Server with a short stand-in for those timeouts (a
// ResponseRecorder has no connection to enforce a deadline on, so it cannot
// reproduce the failure — same reasoning as the log-stream test), and a slow
// but steadily progressing peer. Without the per-route progress wrappers the
// transfer is cut; with them it completes.
//
// The real production timeouts are 30 s, so the test does not have to wait 30 s
// for a deadline to elapse — it sets the server's timeouts to a quarter second
// (headroom for the fsync and database work after the last body read on a slow
// CI runner) and paces the peer well inside them.

// slowReader hands the wrapped body out at most chunk bytes at a time, pausing
// pause between chunks, so the request body arrives slowly but steadily.
type slowReader struct {
	r     io.Reader
	chunk int
	pause time.Duration
}

func (s *slowReader) Read(p []byte) (int, error) {
	if len(p) > s.chunk {
		p = p[:s.chunk]
	}
	n, err := s.r.Read(p)
	if n > 0 {
		time.Sleep(s.pause)
	}
	return n, err
}

// slowConn paces reads from the server, modelling a client on a slow link: it
// drains the socket slowly but never stops, the way curl --limit-rate does.
type slowConn struct {
	net.Conn
	chunk int
	pause time.Duration
}

func (c *slowConn) Read(p []byte) (int, error) {
	time.Sleep(c.pause)
	if len(p) > c.chunk {
		p = p[:c.chunk]
	}
	return c.Conn.Read(p)
}

// smallSendBufferListener forces a tiny kernel send buffer on every accepted
// connection, so a server writing to a slow reader actually blocks on the
// socket (the write deadline can then elapse). Without it the default send
// buffer swallows a multi-MiB body instantly and the deadline never fires,
// which would make the download test pass against the unfixed handler too.
type smallSendBufferListener struct {
	net.Listener
	size int
}

func (l smallSendBufferListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetWriteBuffer(l.size)
	}
	return c, nil
}

// TestUpload_SlowProgressingBodySurvivesRequestTimeout: a body that takes
// several times the server's ReadTimeout to arrive, but never stalls longer
// than it, must be accepted. Against the unfixed handler the whole-request read
// deadline elapses mid-body and the upload fails.
func TestUpload_SlowProgressingBodySurvivesRequestTimeout(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "slow-upload", 1)

	content := bytes.Repeat([]byte("z"), 512<<10) // 512 KiB, several chunks
	body, contentType := makeMultipartFile(t, "file", "slow.bin", content)
	slow := &slowReader{r: body, chunk: 16 << 10, pause: 40 * time.Millisecond}

	srv := httptest.NewUnstartedServer(router)
	srv.Config.ReadTimeout = 250 * time.Millisecond
	srv.Config.WriteTimeout = 250 * time.Millisecond
	srv.Start()
	defer srv.Close()

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/uploads", slow)
	if err != nil {
		t.Fatal(err)
	}
	req.ContentLength = int64(body.Len())
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("slow upload cut by the request timeout: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		msg, _ := io.ReadAll(resp.Body)
		t.Fatalf("slow upload status = %d, want 201; body: %s", resp.StatusCode, msg)
	}
}

// TestServeFile_SlowProgressingClientSurvivesWriteTimeout: a download the
// client drains over several times the server's WriteTimeout, but never stalls
// on, must arrive whole. Against the unfixed handler the write deadline elapses
// mid-copy and the body truncates silently.
func TestServeFile_SlowProgressingClientSurvivesWriteTimeout(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "slow-download", 1)

	content := bytes.Repeat([]byte("y"), 2<<20) // 2 MiB
	rr := doUpload(t, router, token, "file", "big.bin", content)
	if rr.Code != http.StatusCreated {
		t.Fatalf("fixture upload: %d %s", rr.Code, rr.Body.String())
	}
	var up struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &up); err != nil || up.ID == "" {
		t.Fatalf("fixture upload id: %v (%s)", err, rr.Body.String())
	}

	srv := httptest.NewUnstartedServer(router)
	// A tiny send buffer plus a client that drains slowly: the server's writes
	// must then block on the socket so the write deadline is what decides
	// whether the body arrives whole or truncates.
	if ln, ok := srv.Listener.(*net.TCPListener); ok {
		srv.Listener = smallSendBufferListener{Listener: ln, size: 16 << 10}
	}
	srv.Config.ReadTimeout = 250 * time.Millisecond
	srv.Config.WriteTimeout = 250 * time.Millisecond
	srv.Start()
	defer srv.Close()

	// A client that reads at a bounded rate: 64 KiB every 40 ms (~1.6 MiB/s),
	// so the whole 2 MiB takes at least 1.3 s — five times the WriteTimeout —
	// without any single pause exceeding it.
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := (&net.Dialer{}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return &slowConn{Conn: c, chunk: 64 << 10, pause: 40 * time.Millisecond}, nil
		},
	}}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/files/"+up.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("slow download request failed: %v", err)
	}
	defer resp.Body.Close()
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("slow download cut by the write timeout: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("downloaded %d bytes, want %d (truncated by WriteTimeout)", len(got), len(content))
	}
}
