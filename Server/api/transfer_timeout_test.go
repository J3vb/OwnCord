package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/httperr"
)

// A transfer the deadline cuts (no byte for transferProgressTimeout, or past
// its lifetime) must answer the uploader with 408 TRANSFER_TIMED_OUT rather
// than close the socket, so the client can tell it from an outage; a cut
// download has no answer to give and closes short of its Content-Length.
// These run a real http.Server: a ResponseRecorder has no connection deadline.

const testTransferIdle = 200 * time.Millisecond

// startTransferServer serves h with the production shape of the global
// timeouts, shortened like transfer_deadline_test.go does.
func startTransferServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	srv.Config.ReadTimeout = 250 * time.Millisecond
	srv.Config.WriteTimeout = 250 * time.Millisecond
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

// postStalled and postSlow return the response for the caller to close.

// postStalled sends the first sendBytes of body, declares the full length, and
// then sends nothing more, returning the server's answer.
func postStalled(t *testing.T, url, token, contentType string, body []byte, sendBytes int) *http.Response {
	t.Helper()
	pr, pw := io.Pipe()
	t.Cleanup(func() { _ = pw.CloseWithError(io.ErrUnexpectedEOF) })
	go func() { _, _ = pw.Write(body[:sendBytes]) }()

	req, err := http.NewRequest(http.MethodPost, url, pr)
	if err != nil {
		t.Fatal(err)
	}
	req.ContentLength = int64(len(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("stalled upload got no answer: %v", err)
	}
	return resp
}

// postSlow sends body in 4 KiB chunks 40 ms apart: never idle as long as the
// idle rule, but several times the global ReadTimeout in total.
func postSlow(t *testing.T, url, token, contentType string, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, &slowReader{r: bytes.NewReader(body), chunk: 4 << 10, pause: 40 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	req.ContentLength = int64(len(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("slow upload cut: %v", err)
	}
	return resp
}

func assertTransferTimedOut(t *testing.T, resp *http.Response) {
	t.Helper()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("408 body unreadable: %v", err)
	}
	if resp.StatusCode != http.StatusRequestTimeout {
		t.Fatalf("status = %d, want 408; body: %s", resp.StatusCode, raw)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	if body.Error != string(httperr.CodeTransferTimedOut) {
		t.Fatalf("code = %q, want %s; body: %s", body.Error, httperr.CodeTransferTimedOut, raw)
	}
}

// paddedImageForm is a multipart form with a padding field ahead of the image,
// so the body is long enough that a slow sender takes well past ReadTimeout.
func paddedImageForm(t *testing.T, image []byte, pad int) ([]byte, string) {
	t.Helper()
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	if err := w.WriteField("pad", string(bytes.Repeat([]byte("p"), pad))); err != nil {
		t.Fatal(err)
	}
	fw, err := w.CreateFormFile("file", "img.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(image); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), w.FormDataContentType()
}

func TestUpload_StalledBodyAnswers408TransferTimedOut(t *testing.T) {
	api.SetTransferProgressTimeoutForTest(t, testTransferIdle)
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	srv := startTransferServer(t, buildUploadRouter(database, store, nil))
	token := uploadCreateToken(t, database, "stalled-upload", 1)

	body, contentType := makeMultipartFile(t, "file", "stalled.bin", bytes.Repeat([]byte("s"), 512<<10))
	cases := []struct {
		name string
		sent int
	}{
		{"stalled inside the file", 64 << 10},
		{"stalled inside the part headers", 40},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			start := time.Now()
			resp := postStalled(t, srv.URL+"/api/v1/uploads", token, contentType, body.Bytes(), tc.sent)
			defer resp.Body.Close()
			assertTransferTimedOut(t, resp)
			if elapsed := time.Since(start); elapsed < testTransferIdle {
				t.Fatalf("answered after %v, before the %v idle rule", elapsed, testTransferIdle)
			}
		})
	}

	var n int
	if err := database.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM attachments").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("a cut upload left %d attachment rows", n)
	}
}

// profileImageRoute is one of the three image uploads that read their whole
// multipart body before decoding it.
type profileImageRoute struct {
	name, path, token string
	handler           http.Handler
}

func profileImageRoutes(t *testing.T) []profileImageRoute {
	t.Helper()
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	avatar := buildAvatarRouter(database, store)
	banner := buildBannerRouter(database, store, &userUpdateSpy{})
	icon := newIconFixture(t)
	return []profileImageRoute{
		{"avatar", "/api/v1/users/me/avatar", uploadCreateToken(t, database, "slow-avatar", 4), avatar},
		{"banner", "/api/v1/users/me/banner", uploadCreateToken(t, database, "slow-banner", 4), banner},
		{"group icon", icon.iconPath(), icon.tokens["alice"], icon.router},
	}
}

// slowUploadIdle is the idle rule for the slow-upload test. Once the last byte
// arrives the handler has only this long to decode, store and answer: a loaded
// Windows runner with the race detector once took past 2 s there, and an
// expired deadline both cancels the request and cuts the answer. slowUploadPad
// makes the body take about 1.6 times the rule at postSlow's pace (4 KiB every
// 40 ms), so it still only arrives if each chunk re-arms the deadline.
const (
	slowUploadIdle = 5 * time.Second
	slowUploadPad  = 800 << 10
)

func TestProfileImageUploads_SlowProgressingBodySurvivesRequestTimeout(t *testing.T) {
	api.SetTransferProgressTimeoutForTest(t, slowUploadIdle)
	for _, route := range profileImageRoutes(t) {
		t.Run(route.name, func(t *testing.T) {
			srv := startTransferServer(t, route.handler)
			body, contentType := paddedImageForm(t, makePNGBytes(t, 64, 64), slowUploadPad)
			resp := postSlow(t, srv.URL+route.path, route.token, contentType, body)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
				raw, _ := io.ReadAll(resp.Body)
				t.Fatalf("slow %s upload status = %d; body: %s", route.name, resp.StatusCode, raw)
			}
		})
	}
}

func TestProfileImageUploads_StalledBodyAnswers408TransferTimedOut(t *testing.T) {
	api.SetTransferProgressTimeoutForTest(t, testTransferIdle)
	for _, route := range profileImageRoutes(t) {
		t.Run(route.name, func(t *testing.T) {
			srv := startTransferServer(t, route.handler)
			body, contentType := paddedImageForm(t, makePNGBytes(t, 64, 64), 48<<10)
			resp := postStalled(t, srv.URL+route.path, route.token, contentType, body, 8<<10)
			defer resp.Body.Close()
			assertTransferTimedOut(t, resp)
		})
	}
}

// TestServeFile_StalledClientClosesWithContentLengthMismatch: a client that
// stops reading mid-download is abandoned after the idle rule, and what it has
// is visibly short: the body ends before Content-Length.
func TestServeFile_StalledClientClosesWithContentLengthMismatch(t *testing.T) {
	api.SetTransferProgressTimeoutForTest(t, testTransferIdle)
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "stalled-download", 1)

	content := bytes.Repeat([]byte("d"), 8<<20)
	rr := doUpload(t, router, token, "file", "big.bin", content)
	requireStatus(t, rr, http.StatusCreated)
	var up struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &up); err != nil || up.ID == "" {
		t.Fatalf("fixture upload id: %v (%s)", err, rr.Body.String())
	}

	srv := httptest.NewUnstartedServer(router)
	if ln, ok := srv.Listener.(*net.TCPListener); ok {
		srv.Listener = smallSendBufferListener{Listener: ln, size: 16 << 10}
	}
	srv.Config.ReadTimeout = 250 * time.Millisecond
	srv.Config.WriteTimeout = 250 * time.Millisecond
	srv.Start()
	defer srv.Close()

	// A small receive buffer so the stalled client actually backs the
	// server's writes up instead of the kernel absorbing the whole file.
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := (&net.Dialer{}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			if tc, ok := c.(*net.TCPConn); ok {
				_ = tc.SetReadBuffer(16 << 10)
			}
			return c, nil
		},
	}}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/files/"+up.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("download request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.ContentLength != int64(len(content)) {
		t.Fatalf("Content-Length = %d, want %d", resp.ContentLength, len(content))
	}
	if _, err := io.ReadFull(resp.Body, make([]byte, 64<<10)); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	time.Sleep(4 * testTransferIdle)

	got, err := io.ReadAll(resp.Body)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("after the stall: read %d more bytes, err = %v; want the body cut short (unexpected EOF)", len(got), err)
	}
}

// TestUploadAvatar_InFlightUploadsPerUserCapped: a slow avatar upload now
// lives for minutes, so one user may hold only two at a time; a third is
// refused before any of its body is read.
func TestUploadAvatar_InFlightUploadsPerUserCapped(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildAvatarRouter(database, store)
	token := uploadCreateToken(t, database, "busy-avatar", 4)
	raw, contentType := paddedImageForm(t, makePNGBytes(t, 8, 8), 1<<10)

	done := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		pr, pw := io.Pipe()
		t.Cleanup(func() { _ = pw.CloseWithError(io.ErrUnexpectedEOF) })
		req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar", pr)
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("Authorization", "Bearer "+token)
		req.RemoteAddr = "127.0.0.1:9999"
		go func() {
			rr := serveRequest(router, req)
			done <- rr
		}()
		// The write returns once the handler has read it: the upload holds its slot.
		if _, err := pw.Write(raw[:len(raw)/2]); err != nil {
			t.Fatalf("holding upload: %v", err)
		}
	}

	rr := doAvatarUpload(t, router, token, "third.png", makePNGBytes(t, 8, 8))
	if rr.Code != http.StatusTooManyRequests || !strings.Contains(rr.Body.String(), "in progress") {
		t.Fatalf("third concurrent avatar upload = %d %s, want 429", rr.Code, rr.Body.String())
	}
	select {
	case rr := <-done:
		t.Fatalf("a held upload ended early: %d %s", rr.Code, rr.Body.String())
	default:
	}
}
