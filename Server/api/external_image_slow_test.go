package api_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
)

// A reader that keeps taking bytes but needs longer than the server's write timeout must still get the
// whole image.
func TestExternalContent_SlowReaderGetsWholeImage(t *testing.T) {
	api.SetTransferProgressTimeoutForTest(t, 600*time.Millisecond)
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "slowviewer", 4)
	gif := append(append([]byte{}, externalGIF...), make([]byte, 2<<20)...)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(gif)
	}))
	t.Cleanup(stub.Close)
	router := externalRouter(t, database, stub)

	srv := httptest.NewUnstartedServer(router)
	if ln, ok := srv.Listener.(*net.TCPListener); ok {
		srv.Listener = smallSendBufferListener{Listener: ln, size: 128 << 10}
	}
	srv.Config.WriteTimeout = 250 * time.Millisecond
	srv.Start()
	defer srv.Close()

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/external/image?url="+url.QueryEscape(stub.URL+"/a.gif"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := (&net.Dialer{}).DialContext(ctx, network, addr)
			if tc, ok := c.(*net.TCPConn); ok {
				_ = tc.SetReadBuffer(128 << 10)
			}
			return c, err
		},
	}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	// Whole 32 KiB blocks with a pause between them: every piece lands well inside the idle rule, while the
	// total takes longer than it, so only a deadline that keeps moving lets the body finish.
	got := make([]byte, 0, len(gif))
	block := make([]byte, 32<<10)
	for {
		n, err := io.ReadFull(resp.Body, block)
		got = append(got, block[:n]...)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) && len(got) == len(gif) {
				break
			}
			t.Fatalf("read %d of %d bytes, err = %v", len(got), len(gif), err)
		}
		time.Sleep(15 * time.Millisecond)
	}
	if len(got) != len(gif) {
		t.Fatalf("read %d of %d bytes", len(got), len(gif))
	}
}
