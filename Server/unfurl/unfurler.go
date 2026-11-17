// Package unfurl builds link preview cards on the server. A worker pool takes committed
// messages from a bounded queue, fetches each new link once through a Source, stores the card
// and a shrunk thumbnail in the linkpreview Store, and tells the message's audience. A send
// never waits for it: a full queue drops the job.
package unfurl

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/linkwire"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"golang.org/x/sync/singleflight"
)

const (
	defaultWorkers      = 3
	defaultQueueSize    = 256
	defaultBackfillSize = 64
	defaultLinksPerMin  = 20
	// jobTimeout bounds one message, which fetches up to five links one after another.
	jobTimeout = 90 * time.Second
	// dropLogEvery thins the dropped-job log line under sustained overflow.
	dropLogEvery = 100
)

// Ready is a message whose cards changed. Cards is what the message now shows, empty when it
// shows none any more.
type Ready struct {
	MessageID int64
	ChannelID int64
	AuthorID  int64
	// Version is the content version the cards were built for: the message's edited_at, else
	// its timestamp.
	Version string
	Cards   []linkwire.Card
}

// Announcer tells the readers of a message's channel that its cards changed.
type Announcer interface {
	LinkPreviewsReady(ctx context.Context, r Ready)
}

// Options configure an Unfurler. Zero fields take the defaults.
type Options struct {
	// Enabled is link_previews.enabled: false queues nothing.
	Enabled bool
	Workers int
	// QueueSize and BackfillSize bound the live and the backfill queues.
	QueueSize    int
	BackfillSize int
	// ThumbCapBytes is link_previews.thumbnail_cache_mb in bytes; 0 stores cards without images.
	ThumbCapBytes int64
	// LinksPerMinute caps the links one author has fetched per minute.
	LinksPerMinute int
	Now            func() time.Time
	// Log receives the worker's lines; nil uses slog.Default.
	Log *slog.Logger
}

// Unfurler is the worker pool. Build one with New, run it with Start, and give it to the
// services as a linkpreview.Unfurler.
type Unfurler struct {
	opt   Options
	store *linkpreview.Store
	src   Source
	ann   Announcer
	log   *slog.Logger
	now   func() time.Time

	live   chan linkpreview.Job
	low    chan linkpreview.Job
	flight singleflight.Group
	limit  *userLimit
	shown  shownSet

	// pending holds the jobs queued or running, so a message sent for unfurling twice at the
	// same version (a history page read while its first job is still queued) runs once.
	// A leaf lock.
	pendingMu syncutil.Mutex
	pending   map[pendingKey]struct{}

	dropped     atomic.Uint64
	rateLimited atomic.Uint64
	processed   atomic.Uint64
}

var _ linkpreview.Unfurler = (*Unfurler)(nil)

// New builds an Unfurler over a store, a source and an announcer. It runs nothing until Start.
func New(store *linkpreview.Store, src Source, ann Announcer, opt Options) *Unfurler {
	if opt.Workers <= 0 {
		opt.Workers = defaultWorkers
	}
	if opt.QueueSize <= 0 {
		opt.QueueSize = defaultQueueSize
	}
	if opt.BackfillSize <= 0 {
		opt.BackfillSize = defaultBackfillSize
	}
	if opt.LinksPerMinute <= 0 {
		opt.LinksPerMinute = defaultLinksPerMin
	}
	now := opt.Now
	if now == nil {
		now = time.Now
	}
	log := opt.Log
	if log == nil {
		log = slog.Default()
	}
	return &Unfurler{
		opt: opt, store: store, src: src, ann: ann, log: log, now: now,
		live:    make(chan linkpreview.Job, opt.QueueSize),
		low:     make(chan linkpreview.Job, opt.BackfillSize),
		limit:   newUserLimit(opt.LinksPerMinute, time.Minute, now),
		pending: make(map[pendingKey]struct{}),
	}
}

// Start runs the workers and the last-used flusher under ctx and returns the function that
// waits for them. Cancel ctx to stop them; the returned function gives up waiting when its
// own context ends, and reports whether every goroutine had exited by then.
func (u *Unfurler) Start(ctx context.Context) (wait func(context.Context) bool) {
	done := make(chan struct{})
	var running atomic.Int64
	spawn := func(run func(context.Context)) {
		running.Add(1)
		go func() {
			defer func() {
				if running.Add(-1) == 0 {
					close(done)
				}
			}()
			run(ctx)
		}()
	}
	// Held across the spawns so done cannot close before the last goroutine starts.
	running.Add(1)
	for range u.opt.Workers {
		spawn(u.worker)
	}
	spawn(u.runShown)
	if running.Add(-1) == 0 {
		close(done)
	}
	return func(waitCtx context.Context) bool {
		select {
		case <-done:
			return true
		case <-waitCtx.Done():
			return false
		}
	}
}

// Dropped counts jobs a full queue refused.
func (u *Unfurler) Dropped() uint64 { return u.dropped.Load() }

// RateLimited counts jobs refused because their author was over the per-minute link cap.
func (u *Unfurler) RateLimited() uint64 { return u.rateLimited.Load() }

// Processed counts jobs run to the end.
func (u *Unfurler) Processed() uint64 { return u.processed.Load() }

// Enqueue implements linkpreview.Unfurler. A message with no links is skipped unless it was
// edited, since an edit may have removed the links its cards belong to.
func (u *Unfurler) Enqueue(job linkpreview.Job) {
	if !u.opt.Enabled {
		return
	}
	if len(linkpreview.Links(job.Content)) == 0 && !job.Edited {
		return
	}
	u.offer(u.live, job)
}

// EnqueueBackfill implements linkpreview.Unfurler. The fetches a backfill job makes are charged
// to the message's author like any other, so reading history cannot spend more of a site's
// patience than the author could by posting.
func (u *Unfurler) EnqueueBackfill(jobs []linkpreview.Job) int {
	if !u.opt.Enabled {
		return 0
	}
	accepted := 0
	for _, job := range jobs {
		if u.offer(u.low, job) {
			accepted++
		}
	}
	return accepted
}

// pendingKey includes the text because the version has one-second resolution.
type pendingKey struct {
	messageID int64
	version   string
	content   string
}

// claim marks a job pending; false when it already is.
func (u *Unfurler) claim(job linkpreview.Job) bool {
	k := pendingKey{job.MessageID, job.Version, job.Content}
	u.pendingMu.Lock()
	defer u.pendingMu.Unlock()
	if _, ok := u.pending[k]; ok {
		return false
	}
	u.pending[k] = struct{}{}
	return true
}

func (u *Unfurler) release(job linkpreview.Job) {
	u.pendingMu.Lock()
	delete(u.pending, pendingKey{job.MessageID, job.Version, job.Content})
	u.pendingMu.Unlock()
}

// offer queues a job without blocking and counts it dropped when the queue is full. A job for
// a message and version already pending is not queued again, and is not counted as dropped.
func (u *Unfurler) offer(q chan linkpreview.Job, job linkpreview.Job) bool {
	if !u.claim(job) {
		return false
	}
	select {
	case q <- job:
		return true
	default:
		u.release(job)
		if n := u.dropped.Add(1); n%dropLogEvery == 1 {
			u.log.Warn("link preview queue full; job dropped", "dropped_total", n, "message_id", job.MessageID)
		}
		return false
	}
}

// worker runs jobs until ctx ends, live before backfill.
func (u *Unfurler) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-u.live:
			u.run(ctx, job)
			continue
		default:
		}
		select {
		case <-ctx.Done():
			return
		case job := <-u.live:
			u.run(ctx, job)
		case job := <-u.low:
			u.run(ctx, job)
		}
	}
}

// run processes one job under its own deadline. A panic is logged and ends only that job.
func (u *Unfurler) run(ctx context.Context, job linkpreview.Job) {
	ctx, cancel := context.WithTimeout(ctx, jobTimeout)
	defer cancel()
	defer u.release(job)
	defer func() {
		if r := recover(); r != nil {
			u.log.Error("link preview job panicked", "message_id", job.MessageID, "panic", r)
		}
	}()
	u.process(ctx, job)
	u.processed.Add(1)
}
