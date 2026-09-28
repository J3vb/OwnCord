package admin

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// The server's global ReadTimeout/WriteTimeout are 30 s, which a
// multi-gigabyte archive cannot be built and sent in. Like the transfer
// routes (api/transfer_deadline.go, which admin cannot import), an archive
// request instead gets a progress deadline: every chunk written pushes the
// connection's deadlines out by archiveProgressTimeout, so a client that stops
// reading is abandoned, while a slow but moving one is not cut.
// archiveMaxLifetime is the hard bound on one archive request, build and
// transfer together, however it progresses: 2 h carries tens of gigabytes
// over an ordinary uplink. At shutdown, EndArchives pulls that bound in to
// archiveShutdownGrace, so an archive cannot hold the 30 s drain.
const (
	archiveProgressTimeout = 30 * time.Second
	archiveMaxLifetime     = 2 * time.Hour
	archiveShutdownGrace   = 20 * time.Second
)

// archivesInFlight holds the archive requests still running, and the servers
// that have begun shutting down.
var archivesInFlight = struct {
	mu      syncutil.Mutex
	set     map[*archiveDeadline]struct{}
	closing map[*http.Server]time.Time
}{set: map[*archiveDeadline]struct{}{}, closing: map[*http.Server]time.Time{}}

// EndArchives returns srv's shutdown hook: every archive request srv is
// serving, and any that starts on srv afterwards, must end within
// archiveShutdownGrace of the hook running. Register it with
// http.Server.RegisterOnShutdown: Shutdown waits for every active handler.
func EndArchives(srv *http.Server) func() {
	return shutdownArchives(srv, archiveShutdownGrace)
}

// shutdownArchives is EndArchives with the grace supplied, so tests can use a
// short one.
func shutdownArchives(srv *http.Server, grace time.Duration) func() {
	return func() {
		archivesInFlight.mu.Lock()
		defer archivesInFlight.mu.Unlock()
		cutoff := time.Now().Add(grace)
		archivesInFlight.closing[srv] = cutoff
		for d := range archivesInFlight.set {
			if d.srv == srv {
				d.capAt(cutoff)
			}
		}
	}
}

// archiveDeadline owns one archive request's deadlines. It is the io.Writer
// the archive is copied through, and its context, which the build runs
// under, ends at the lifetime bound.
type archiveDeadline struct {
	w     io.Writer
	ctl   *http.ResponseController
	idle  time.Duration
	srv   *http.Server
	timer *time.Timer

	mu    syncutil.Mutex
	until time.Time
}

// startArchive starts an archive request's deadlines; cancel ends the context
// the build runs under, and is called at the lifetime bound. Nothing is
// written while the archive builds, so the connection starts at the lifetime
// bound; each written chunk re-arms it. The handler must defer release.
func startArchive(w http.ResponseWriter, r *http.Request, cancel context.CancelFunc, idle, lifetime time.Duration) *archiveDeadline {
	srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
	d := &archiveDeadline{
		w:     w,
		ctl:   http.NewResponseController(w),
		idle:  idle,
		srv:   srv,
		until: time.Now().Add(lifetime),
	}
	d.mu.Lock()
	d.timer = time.AfterFunc(lifetime, cancel)
	d.setDeadlines(d.until)
	d.mu.Unlock()

	archivesInFlight.mu.Lock()
	if cutoff, closing := archivesInFlight.closing[srv]; closing && srv != nil {
		d.capAt(cutoff)
	}
	archivesInFlight.set[d] = struct{}{}
	archivesInFlight.mu.Unlock()
	return d
}

// release drops the request from the in-flight set once the handler is done.
func (d *archiveDeadline) release() {
	archivesInFlight.mu.Lock()
	delete(archivesInFlight.set, d)
	archivesInFlight.mu.Unlock()
	d.timer.Stop()
}

// capAt pulls the lifetime bound in to cutoff: the connection's deadlines and
// the build's context both end by then.
func (d *archiveDeadline) capAt(cutoff time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !cutoff.Before(d.until) {
		return
	}
	d.until = cutoff
	d.timer.Reset(time.Until(cutoff))
	d.arm()
}

// touch pushes both deadlines out to now+idle, never past until.
func (d *archiveDeadline) touch() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.arm()
}

// arm sets both deadlines to now+idle, never past until; d.mu must be held.
func (d *archiveDeadline) arm() {
	deadline := time.Now().Add(d.idle)
	if deadline.After(d.until) {
		deadline = d.until
	}
	d.setDeadlines(deadline)
}

// setDeadlines sets both deadlines; the read one too, because on HTTP/1.1 an
// expired read deadline cancels the request context mid-response. Errors are
// ignored: the only realistic one is http.ErrNotSupported on a writer with no
// connection, where there is no deadline to manage.
func (d *archiveDeadline) setDeadlines(deadline time.Time) {
	_ = d.ctl.SetReadDeadline(deadline)
	_ = d.ctl.SetWriteDeadline(deadline)
}

// Write re-arms the deadlines on every write that lands bytes.
func (d *archiveDeadline) Write(b []byte) (int, error) {
	n, err := d.w.Write(b)
	if n > 0 {
		d.touch()
	}
	return n, err
}
