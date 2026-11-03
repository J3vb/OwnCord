package api

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Per-route progress deadlines for the file transfer routes.
// The global ReadTimeout/WriteTimeout (internal/app/lifecycle.go) are 30 s and
// bound the WHOLE request: net/http sets the connection deadlines once, when
// headers are read, and nothing in a handler extends them. A 25 MB upload on a
// slow uplink needs about 200 s at 1 Mbit/s, so it would be cut mid-body and the
// same file's download truncated silently.
// Rather than relax the global timeouts (which would weaken slowloris protection
// for every route), the two transfer routes wrap their reader/writer so every
// chunk that moves pushes the connection deadline forward. A progressing
// transfer is not cut before its lifetime (transferLifetimeFor, sized from the
// upload cap or the file), a peer that stops is abandoned after
// transferProgressTimeout, and no transfer outlives transferMaxLifetime.
// An upload cut by either rule answers 408 TRANSFER_TIMED_OUT
// (writeTransferTimedOut) instead of a closed socket, so the client can tell it
// from an outage.
// admin/logstream.go applies the same SetWriteDeadline(time.Time{}) override to
// its stream.
// The deadline lives on the underlying *net.Conn, reached through
// http.NewResponseController; over a writer without a real connection
// (httptest.ResponseRecorder) the controller reports http.ErrNotSupported and
// this is a no-op.
// Because a transfer can now outlive the 30 s graceful-shutdown budget,
// CancelInFlightTransfers (registered with http.Server.RegisterOnShutdown) caps
// every transfer at shutdownTransferGrace from the start of shutdown, so short
// transfers finish and the drain stays bounded.

// transferProgressTimeout is the gap without any byte read or written after
// which a transfer is abandoned. A variable only so tests can shorten it.
var transferProgressTimeout = 30 * time.Second

// errTransferTimedOut marks a body read cut by the transfer deadline, through
// whatever wraps it (the multipart parser, storage.Save).
var errTransferTimedOut = errors.New("transfer deadline passed")

// transferLifetimeFor is the total lifetime of a transfer of size bytes: the
// time it takes at transferSlowestRate, clamped to [transferMinLifetime,
// transferMaxLifetime].
func transferLifetimeFor(size int64) time.Duration {
	secs := size / transferSlowestRate
	if secs >= int64(transferMaxLifetime/time.Second) {
		return transferMaxLifetime
	}
	return max(transferMinLifetime, time.Duration(secs)*time.Second)
}

// inFlight holds the transfers whose handlers are still running and the servers
// that have begun shutting down.
var inFlight = struct {
	mu      syncutil.Mutex
	set     map[*transferDeadline]struct{}
	closing map[*http.Server]time.Time
}{set: map[*transferDeadline]struct{}{}, closing: map[*http.Server]time.Time{}}

// CancelInFlightTransfers returns srv's shutdown hook: every transfer srv is
// serving, and any that starts on srv afterwards, must end within
// shutdownTransferGrace of the hook running.
func CancelInFlightTransfers(srv *http.Server) func() {
	return shutdownTransfers(srv, shutdownTransferGrace)
}

// shutdownTransfers is CancelInFlightTransfers with the grace supplied, so tests
// can use a short one.
func shutdownTransfers(srv *http.Server, grace time.Duration) func() {
	return func() {
		inFlight.mu.Lock()
		defer inFlight.mu.Unlock()
		cutoff := time.Now().Add(grace)
		inFlight.closing[srv] = cutoff
		for d := range inFlight.set {
			if d.srv == srv {
				d.capAt(cutoff)
			}
		}
	}
}

type transferDeadline struct {
	ctl     *http.ResponseController
	timeout time.Duration
	srv     *http.Server

	mu      syncutil.Mutex
	until   time.Time
	expired bool
}

// newTransferDeadline starts the deadlines of a transfer of up to size bytes;
// the handler must defer release so a later shutdown does not touch a
// connection it no longer owns.
func newTransferDeadline(w http.ResponseWriter, r *http.Request, size int64) *transferDeadline {
	return startTransfer(w, r, transferProgressTimeout, transferLifetimeFor(size))
}

// transferBody caps r's body at maxBytes and reads it under a transfer
// deadline sized for maxBytes, returning the deadline's release for the
// handler to defer. A read the deadline cuts fails with errTransferTimedOut.
func transferBody(w http.ResponseWriter, r *http.Request, maxBytes int64) (release func()) {
	d := newTransferDeadline(w, r, maxBytes)
	d.touch()
	r.Body = progressReader{r: http.MaxBytesReader(w, r.Body, maxBytes), d: d}
	return d.release
}

func startTransfer(w http.ResponseWriter, r *http.Request, timeout, lifetime time.Duration) *transferDeadline {
	srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
	d := &transferDeadline{
		ctl:     http.NewResponseController(w),
		timeout: timeout,
		srv:     srv,
		until:   time.Now().Add(lifetime),
	}
	inFlight.mu.Lock()
	if cutoff, closing := inFlight.closing[srv]; closing && srv != nil && cutoff.Before(d.until) {
		d.until = cutoff
	}
	inFlight.set[d] = struct{}{}
	inFlight.mu.Unlock()
	return d
}

func (d *transferDeadline) release() {
	inFlight.mu.Lock()
	delete(inFlight.set, d)
	inFlight.mu.Unlock()
}

func (d *transferDeadline) capAt(cutoff time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if cutoff.Before(d.until) {
		d.until = cutoff
	}
	d.arm()
}

// touch pushes both deadlines out to now+timeout, never past until. Errors are
// ignored: the only realistic one is http.ErrNotSupported on a writer with no
// connection, where there is no deadline to manage.
func (d *transferDeadline) touch() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.arm()
}

func (d *transferDeadline) arm() {
	if d.expired {
		return
	}
	deadline := time.Now().Add(d.timeout)
	if deadline.After(d.until) {
		deadline = d.until
	}
	_ = d.ctl.SetReadDeadline(deadline)
	_ = d.ctl.SetWriteDeadline(deadline)
}

// expire records that the deadline cut the transfer. Progress no longer
// re-arms anything; the write deadline moves to now+transferTimedOutWriteGrace
// so an upload handler can still deliver its 408 (a download has nothing left
// to say and its connection closes).
func (d *transferDeadline) expire() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.expired {
		return
	}
	d.expired = true
	_ = d.ctl.SetWriteDeadline(time.Now().Add(transferTimedOutWriteGrace))
}

// timedOut reports whether the deadline cut the transfer.
func (d *transferDeadline) timedOut() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.expired
}

// writeTransferTimedOut answers 408 TRANSFER_TIMED_OUT when err is a body read
// the transfer deadline cut, reporting whether it did.
func writeTransferTimedOut(w http.ResponseWriter, err error, what string) bool {
	if !errors.Is(err, errTransferTimedOut) {
		return false
	}
	slog.Info("upload cut by the transfer deadline", "upload", what, "error", err)
	writeErr(w, http.StatusRequestTimeout, httperr.CodeTransferTimedOut,
		"the upload took too long for this connection; try a smaller file or a faster link")
	return true
}

// progressReader re-arms the transfer deadline on every read that returns bytes,
// so a slow but moving body is not cut by the connection's read deadline. It
// wraps http.MaxBytesReader's result and preserves Close.
type progressReader struct {
	r io.ReadCloser
	d *transferDeadline
}

func (p progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.d.touch()
	}
	if err != nil && errors.Is(err, os.ErrDeadlineExceeded) {
		p.d.expire()
		return n, fmt.Errorf("%w: %w", errTransferTimedOut, err)
	}
	return n, err
}

func (p progressReader) Close() error { return p.r.Close() }

// progressWriter re-arms the transfer deadline on every write that lands bytes,
// so a slow but moving download is not cut by the connection's write deadline.
type progressWriter struct {
	http.ResponseWriter
	d *transferDeadline
}

func (p progressWriter) Write(b []byte) (int, error) {
	n, err := p.ResponseWriter.Write(b)
	if n > 0 {
		p.d.touch()
	}
	if err != nil && errors.Is(err, os.ErrDeadlineExceeded) {
		p.d.expire()
	}
	return n, err
}

// Unwrap keeps http.NewResponseController able to reach the connection through
// this wrapper.
func (p progressWriter) Unwrap() http.ResponseWriter { return p.ResponseWriter }

// uploadSlots counts each user's in-flight uploads against
// maxConcurrentUploadsPerUser, bounding one member's reserved headroom to that
// many times the per-file cap (the 30 s whole-request timeout used to bound it
// implicitly). It lives here beside the transfer-deadline machinery to keep
// upload_handler.go under the file-size invariant.
type uploadSlots struct {
	mu syncutil.Mutex
	n  map[int64]int
}

// acquire takes a slot for userID, reporting false at the per-user cap. Callers
// must release the slot on every path.
func (s *uploadSlots) acquire(userID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.n[userID] >= maxConcurrentUploadsPerUser {
		return false
	}
	s.n[userID]++
	return true
}

// release returns userID's slot, dropping the map entry at zero so the map
// does not grow one entry per uploader for the process lifetime.
func (s *uploadSlots) release(userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.n[userID] <= 1 {
		delete(s.n, userID)
		return
	}
	s.n[userID]--
}
