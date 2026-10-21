package api_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"

	"github.com/coder/websocket"
)

// The production router carries the middleware: a 1 ns deadline fails a bound
// authenticated GET with 503 and Retry-After, and a 50 ms deadline does not
// close a WebSocket that is still open 200 ms later. Removing the r.Use in
// routerMiddleware makes the first half fail.
func TestRequestDeadline_ProductionRouterWiring(t *testing.T) {
	handler, database := fullRouterWithDB(t)
	token, _ := mintSession(t, database, mintUser(t, database, "deadline-user"))

	// 1. A 1 ns deadline expires before the database calls of a bound route
	// complete, so the handler (or the auth gate) fails after the deadline;
	// the production stack must answer that 503. Retried because a very fast
	// host can finish a request inside 1 ms (a 200 is never rewritten).
	api.SetRestRequestDeadlineForTest(t, time.Nanosecond)
	srv := httptest.NewServer(handler)
	defer srv.Close()
	ok := false
	var last *httptest.ResponseRecorder
	for range 50 {
		rec := httptest.NewRecorder()
		hreq := httptest.NewRequest(http.MethodGet, "/api/v1/channels/", nil)
		hreq.Header.Set("Authorization", "Bearer "+token)
		handler.ServeHTTP(rec, hreq)
		last = rec
		if rec.Code == http.StatusServiceUnavailable && rec.Header().Get("Retry-After") == "2" {
			ok = true
			break
		}
	}
	if !ok {
		t.Fatalf("no 503 with Retry-After: 2 from the production router at a 1 ns deadline (last %d %s); the middleware is not wired", last.Code, last.Body.String())
	}

	// 2. WebSocket under a short deadline stays open.
	api.SetRestRequestDeadlineForTest(t, 50*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/ws", nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	readCtx, readCancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer readCancel()
	_, _, err = conn.Read(readCtx)
	var ce websocket.CloseError
	if errors.As(err, &ce) || (err != nil && !errors.Is(err, context.DeadlineExceeded)) {
		t.Fatalf("socket closed within 200 ms of a 50 ms deadline: %v", err)
	}
}
