package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// threadArchiveBatch bounds one ArchiveDueThreads call.
const threadArchiveBatch = 200

// threadArchiveStore is the slice of ThreadStore the archiver reads and writes.
type threadArchiveStore interface {
	NextThreadArchiveDue(ctx context.Context) (time.Time, bool, error)
	ArchiveDueThreads(ctx context.Context, now time.Time, limit int) (archived []db.DueThread, listed int, err error)
}

// ThreadNotifier is told when the archiver archived a thread, so live clients
// can move it. The hub implements it (a coalesced thread_changed).
type ThreadNotifier interface {
	ThreadChanged(threadID int64)
}

// ThreadArchiver archives idle threads: one goroutine (Run) sleeps until the
// earliest open thread falls due (capped at expirerMaxSleep), archives every due
// thread and tells the notifier. Correctness does not depend on it: a late flag
// only keeps a thread showing active longer, and a post reopens an archived thread.
type ThreadArchiver struct {
	st threadArchiveStore

	mu       syncutil.Mutex
	notifier ThreadNotifier

	// Timing knobs; tests shorten them.
	now        func() time.Time
	slack      time.Duration
	maxSleep   time.Duration
	retryAfter time.Duration
}

// NewThreadArchiver returns an archiver over st's thread storage. A store
// without it (a test double) gives an archiver that does nothing. st is only
// checked for threadArchiveStore, so it takes any value.
func NewThreadArchiver(st any) *ThreadArchiver {
	a := &ThreadArchiver{
		now: time.Now, slack: expirerSlack, maxSleep: expirerMaxSleep, retryAfter: expirerRetryAfterError,
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

// Sweep archives every due thread once and returns the first error. The boot
// stage calls it before the listener opens.
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
		// A full batch that archived something may have more behind it.
		// Threads that listed but did not archive were posted to meanwhile.
		if listed < threadArchiveBatch || len(archived) == 0 {
			return nil
		}
	}
}

// Run is the archiver loop. It returns when ctx is done.
func (a *ThreadArchiver) Run(ctx context.Context) {
	if a.st == nil {
		return
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		sleep, failed := a.nextSleep(ctx)
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
		case <-timer.C:
		}
		if failed {
			continue
		}
		if err := a.Sweep(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Warn("thread archiver: sweep failed", "err", err)
			a.sleepOrDone(ctx, a.retryAfter)
		}
	}
}

// sleepOrDone waits d or until ctx is done.
func (a *ThreadArchiver) sleepOrDone(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// nextSleep reads the earliest due time and returns how long to sleep. failed
// is true after a read error, where the sleep is the retry delay and the sweep
// is skipped.
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
	sleep = due.Add(a.slack).Sub(a.now())
	return min(max(sleep, 0), a.maxSleep), false
}
