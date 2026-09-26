package api

import (
	"io"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// SRV-05: per-route progress deadlines for the file transfer routes.
//
// The server's global ReadTimeout/WriteTimeout (internal/app/lifecycle.go) are
// 30 s and bound the WHOLE request: net/http sets the connection's read and
// write deadlines once, when request headers are read, and nothing in a
// handler extends them. A 25 MB upload on a slow uplink needs about 200 s at
// 1 Mbit/s, so without an override it is cut mid-body, and the download of
// that same file truncates silently once the write deadline elapses.
//
// Rather than relax the global timeouts (which would weaken the slowloris
// posture for every route), the two transfer routes wrap their reader/writer so
// every chunk that actually moves pushes the connection deadline forward. A
// transfer that keeps progressing is not cut before transferMaxLifetime; a peer that stops sending or
// reading is abandoned after transferProgressTimeout, and no transfer outlives
// transferMaxLifetime however it progresses. This mirrors the
// SetWriteDeadline(time.Time{}) override admin/logstream.go already applies to
// its own long-lived stream.
//
// The deadline lives on the underlying *net.Conn, reached through
// http.NewResponseController, which unwraps the middleware chain. When the
// writer does not sit over a real connection (an httptest.ResponseRecorder,
// say) the controller reports http.ErrNotSupported and this is a no-op.
//
// Because a transfer can now outlive the 30 s graceful-shutdown budget,
// CancelInFlightTransfers (registered with http.Server.RegisterOnShutdown)
// cuts every in-flight transfer's deadline to now so the drain stays bounded.

// inFlight holds the transfers whose handlers are still running, and the
// servers that have begun shutting down.
var inFlight = struct {
	mu      syncutil.Mutex
	set     map[*transferDeadline]struct{}
	closing map[*http.Server]struct{}
}{set: map[*transferDeadline]struct{}{}, closing: map[*http.Server]struct{}{}}

// CancelInFlightTransfers returns srv's shutdown hook: it cuts every transfer
// srv is serving, and any that starts on srv afterwards is cut at once.
func CancelInFlightTransfers(srv *http.Server) func() {
	return func() {
		inFlight.mu.Lock()
		defer inFlight.mu.Unlock()
		inFlight.closing[srv] = struct{}{}
		for d := range inFlight.set {
			if d.srv == srv {
				d.cut()
			}
		}
	}
}

// transferDeadline owns one response's progress deadlines.
type transferDeadline struct {
	ctl     *http.ResponseController
	timeout time.Duration
	srv     *http.Server

	mu    syncutil.Mutex
	until time.Time
}

// newTransferDeadline starts a transfer's deadlines; the handler must defer
// release so a later shutdown does not touch a connection it no longer owns.
func newTransferDeadline(w http.ResponseWriter, r *http.Request) *transferDeadline {
	return startTransfer(w, r, transferProgressTimeout, transferMaxLifetime)
}

// startTransfer is newTransferDeadline with the bounds supplied, so tests can
// use short ones.
func startTransfer(w http.ResponseWriter, r *http.Request, timeout, lifetime time.Duration) *transferDeadline {
	srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
	d := &transferDeadline{
		ctl:     http.NewResponseController(w),
		timeout: timeout,
		srv:     srv,
		until:   time.Now().Add(lifetime),
	}
	inFlight.mu.Lock()
	if _, closing := inFlight.closing[srv]; closing && srv != nil {
		d.until = time.Now()
	}
	inFlight.set[d] = struct{}{}
	inFlight.mu.Unlock()
	return d
}

// release drops the transfer from the in-flight set once the handler is done.
func (d *transferDeadline) release() {
	inFlight.mu.Lock()
	delete(inFlight.set, d)
	inFlight.mu.Unlock()
}

// cut ends the transfer now: the lifetime cap moves to the present, so any
// blocked read or write fails and no later touch can re-arm past it.
func (d *transferDeadline) cut() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.until = time.Now()
	d.set(d.until)
}

// touch pushes both deadlines out to now+timeout, never past until. Errors are ignored: the only
// realistic one is http.ErrNotSupported on a writer with no connection, where
// there is no deadline to manage anyway (a real net/http server always
// supports it).
func (d *transferDeadline) touch() {
	d.mu.Lock()
	defer d.mu.Unlock()
	deadline := time.Now().Add(d.timeout)
	if deadline.After(d.until) {
		deadline = d.until
	}
	d.set(deadline)
}

func (d *transferDeadline) set(deadline time.Time) {
	_ = d.ctl.SetReadDeadline(deadline)
	_ = d.ctl.SetWriteDeadline(deadline)
}

// progressReader re-arms the transfer deadline on every read that returns
// bytes, so a slow but moving body is not cut by the connection's read
// deadline before transferMaxLifetime. It wraps an io.ReadCloser (http.MaxBytesReader's result) and
// preserves Close.
type progressReader struct {
	r io.ReadCloser
	d *transferDeadline
}

func (p progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.d.touch()
	}
	return n, err
}

func (p progressReader) Close() error { return p.r.Close() }

// progressWriter re-arms the transfer deadline on every write that lands
// bytes, so a slow but moving download is not cut by the connection's write
// deadline before transferMaxLifetime.
type progressWriter struct {
	http.ResponseWriter
	d *transferDeadline
}

func (p progressWriter) Write(b []byte) (int, error) {
	n, err := p.ResponseWriter.Write(b)
	if n > 0 {
		p.d.touch()
	}
	return n, err
}

// Unwrap keeps http.NewResponseController able to reach the underlying
// connection through this wrapper.
func (p progressWriter) Unwrap() http.ResponseWriter { return p.ResponseWriter }
