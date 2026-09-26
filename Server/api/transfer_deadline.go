package api

import (
	"io"
	"net/http"
	"time"
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
// transfer that keeps progressing is never cut; a peer that stops sending or
// reading is abandoned after transferProgressTimeout. This mirrors the
// SetWriteDeadline(time.Time{}) override admin/logstream.go already applies to
// its own long-lived stream.
//
// The deadline lives on the underlying *net.Conn, reached through
// http.NewResponseController, which unwraps the middleware chain. When the
// writer does not sit over a real connection (an httptest.ResponseRecorder,
// say) the controller reports http.ErrNotSupported and this is a no-op.

// transferDeadline owns one response's progress deadlines.
type transferDeadline struct {
	ctl     *http.ResponseController
	timeout time.Duration
}

func newTransferDeadline(w http.ResponseWriter) *transferDeadline {
	return &transferDeadline{ctl: http.NewResponseController(w), timeout: transferProgressTimeout}
}

// touch pushes both deadlines out to now+timeout. Errors are ignored: the only
// realistic one is http.ErrNotSupported on a writer with no connection, where
// there is no deadline to manage anyway (a real net/http server always
// supports it).
func (d *transferDeadline) touch() {
	deadline := time.Now().Add(d.timeout)
	_ = d.ctl.SetReadDeadline(deadline)
	_ = d.ctl.SetWriteDeadline(deadline)
}

// progressReader re-arms the transfer deadline on every read that returns
// bytes, so a slow but moving body is never cut by the connection's read
// deadline. It wraps an io.ReadCloser (http.MaxBytesReader's result) and
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
// bytes, so a slow but moving download is never cut by the connection's write
// deadline.
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
