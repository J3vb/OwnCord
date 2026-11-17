package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

const threadArchiveBatch = 200

type threadArchiveStore interface {
	NextThreadArchiveDue(ctx context.Context) (time.Time, bool, error)
	ArchiveDueThreads(ctx context.Context, now time.Time, limit int) (archived []db.DueThread, listed int, err error)
}

// ThreadNotifier is told when the archiver archived a thread, so live clients can move it. The hub implements
// it (a coalesced thread_changed).
type ThreadNotifier interface {
	ThreadChanged(threadID int64)
}

// ThreadArchiver archives idle threads: one goroutine (Run) sleeps until the earliest open thread falls due
// (capped at expirerMaxSleep), archives every due thread and tells the notifier. Wake makes it re-read the
// earliest due time when a thread can fall due sooner than planned (a shorter idle period); a create or post
// only moves a due time later, which the capped sleep always reaches in time. Correctness does not depend on
// it: a late flag only keeps a thread showing active longer, and a post reopens an archived thread.
type ThreadArchiver struct {
	st   threadArchiveStore
	wake chan struct{} // size 1: an idle period was shortened

	mu       syncutil.Mutex
	notifier ThreadNotifier

	// Timing knobs; tests shorten them.
	now        func() time.Time
	slack      time.Duration
	maxSleep   time.Duration
	retryAfter time.Duration
}

// NewThreadArchiver returns an archiver over st's thread storage; a store without it (a test double) gives
// one that does nothing.
func NewThreadArchiver(st any) *ThreadArchiver {
	a := &ThreadArchiver{
		wake: make(chan struct{}, 1),
		now:  time.Now, slack: expirerSlack, maxSleep: expirerMaxSleep, retryAfter: expirerRetryAfterError,
	}
	if ts, ok := st.(threadArchiveStore); ok {
		a.st = ts
	}
	return a
}

// SetNotifier installs the notifier an archived thread is reported to.
func (a *ThreadArchiver) SetNotifier(n ThreadNotifier) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.notifier = n
}

// Wake makes Run re-read the earliest due time. It never blocks: a wake already pending covers this one.
func (a *ThreadArchiver) Wake() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

// Sweep archives every due thread once and returns the first error. The boot stage calls it before the
// listener opens.
func (a *ThreadArchiver) Sweep(ctx context.Context) error {
	if a.st == nil {
		return nil
	}
	a.mu.Lock()
	notifier := a.notifier
	a.mu.Unlock()
	for {
		archived, listed, err := a.st.ArchiveDueThreads(ctx, a.now().UTC(), threadArchiveBatch)
		if err != nil {
			return fmt.Errorf("archive due threads: %w", err)
		}
		if notifier != nil {
			for _, t := range archived {
				notifier.ThreadChanged(t.ID)
			}
		}
		// A full batch that archived something may have more behind it; threads that listed but did not archive
		// were posted to meanwhile.
		if listed < threadArchiveBatch || len(archived) == 0 {
			return nil
		}
	}
}

// Run is the archiver loop.
func (a *ThreadArchiver) Run(ctx context.Context) {
	if a.st == nil {
		return
	}
	runDueLoop(ctx, a.wake, a.nextSleep, a.Sweep, a.retryAfter, func(err error) {
		slog.Warn("thread archiver: sweep failed", "err", err)
	})
}

// nextSleep reads the earliest due time and returns how long to sleep. failed is true after a read error,
// where the sleep is the retry delay and the sweep is skipped.
func (a *ThreadArchiver) nextSleep(ctx context.Context) (sleep time.Duration, failed bool) {
	due, ok, err := a.st.NextThreadArchiveDue(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("thread archiver: read next due failed", "err", err)
		}
		return a.retryAfter, true
	}
	if !ok {
		return a.maxSleep, false
	}
	return dueSleep(due, a.now(), a.slack, a.maxSleep), false
}
