package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// pollExpirerBatch bounds one ListDuePolls read.
const pollExpirerBatch = 200

// pollExpiryStore is the slice of the database the expirer reads.
type pollExpiryStore interface {
	NextPollExpiry(ctx context.Context) (string, bool, error)
	ListDuePolls(ctx context.Context, now string, limit int) ([]db.DuePoll, error)
}

// pollEnder ends one due poll and returns what to announce, or nil when there
// is nothing to announce. MessageService.ExpirePoll is it.
type pollEnder interface {
	ExpirePoll(ctx context.Context, messageID int64) (*PollUpdate, error)
}

// PollExpirer pushes the end of polls. Correctness does not depend on it: a
// vote is refused after expiry by the database clock whether or not the timer
// ran, and history reads an expired poll as ended. What the expirer adds is the
// poll_update that tells live clients the final counts, and marking the poll
// ended so it leaves the pending set. One goroutine (Run) sleeps until the
// soonest expiry among polls not yet ended, then ends each due poll with the
// same conditional end the button uses and hands each poll it really ended to
// the notifier.
type PollExpirer struct {
	st    pollExpiryStore
	ender pollEnder
	wake  chan struct{} // size 1: a poll was just created

	mu       syncutil.Mutex
	notifier PollNotifier

	// Timing knobs; tests shorten them.
	now        func() time.Time
	slack      time.Duration
	maxSleep   time.Duration
	retryAfter time.Duration
	batch      int
}

// NewPollExpirer returns an expirer over st that ends polls through ender.
// Install the notifier with SetNotifier before Run.
func NewPollExpirer(st pollExpiryStore, ender pollEnder) *PollExpirer {
	return &PollExpirer{
		st:         st,
		ender:      ender,
		wake:       make(chan struct{}, 1),
		now:        time.Now,
		slack:      expirerSlack,
		maxSleep:   expirerMaxSleep,
		retryAfter: expirerRetryAfterError,
		batch:      pollExpirerBatch,
	}
}

// SetNotifier installs the notifier an ended poll is reported to.
func (e *PollExpirer) SetNotifier(n PollNotifier) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.notifier = n
}

// Wake makes Run re-read the soonest expiry. It never blocks: a wake already
// pending covers this one.
func (e *PollExpirer) Wake() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// Sweep ends every poll that is due, once, and returns the first error. A poll
// that cannot be ended does not stop the ones behind it. It is also the boot
// sweep: polls that expired while the server was down are ended and announced
// before the listener opens.
func (e *PollExpirer) Sweep(ctx context.Context) error {
	e.mu.Lock()
	notifier := e.notifier
	e.mu.Unlock()
	var first error
	for {
		now := e.now().UTC().Format(dbtime.ISOLayout)
		rows, err := e.st.ListDuePolls(ctx, now, e.batch)
		if err != nil {
			return fmt.Errorf("list due polls: %w", err)
		}
		done := 0
		for i := range rows {
			u, err := e.ender.ExpirePoll(ctx, rows[i].MessageID)
			if err != nil {
				if first == nil {
					first = fmt.Errorf("end poll %d: %w", rows[i].MessageID, err)
				}
				continue
			}
			done++
			if u != nil && notifier != nil {
				notifier.PollUpdated(ctx, *u)
			}
		}
		// A full batch with progress may have more behind it. Every poll that
		// was ended, announced or skipped has left the pending set, so the
		// next read cannot return it again.
		if len(rows) < e.batch || done == 0 {
			return first
		}
	}
}

// Run is the expirer loop. It returns when ctx is done.
func (e *PollExpirer) Run(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		sleep, failed := e.nextSleep(ctx)
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(sleep)
		select {
		case <-ctx.Done():
			return
		case <-e.wake:
			// A poll was created: re-read the soonest deadline.
			continue
		case <-timer.C:
		}
		if failed {
			continue
		}
		if err := e.Sweep(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Warn("poll expirer: sweep failed", "err", err)
			e.sleepOrDone(ctx, e.retryAfter)
		}
	}
}

// sleepOrDone waits d or until ctx is done.
func (e *PollExpirer) sleepOrDone(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// nextSleep reads the soonest expiry and returns how long to sleep. failed is
// true after a read error, where the sleep is the retry delay and the sweep is
// skipped.
func (e *PollExpirer) nextSleep(ctx context.Context) (sleep time.Duration, failed bool) {
	next, ok, err := e.st.NextPollExpiry(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("poll expirer: read next expiry failed", "err", err)
		}
		return e.retryAfter, true
	}
	if !ok {
		return e.maxSleep, false
	}
	at, err := time.Parse(dbtime.ISOLayout, next)
	if err != nil {
		slog.Warn("poll expirer: unparseable expiry", "expires_at", next, "err", err)
		return e.retryAfter, false
	}
	sleep = at.Add(e.slack).Sub(e.now())
	return min(max(sleep, 0), e.maxSleep), false
}
