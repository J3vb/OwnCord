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

// MinCustomStatusExpirySeconds and MaxCustomStatusExpirySeconds bound
// presence_update's custom_status_expires_in, in seconds.
const (
	MinCustomStatusExpirySeconds = 60
	MaxCustomStatusExpirySeconds = 604800
)

const (
	// expirerSlack is added to a deadline before the sweep, so the clock the
	// sweep compares against is past it at second precision.
	expirerSlack = time.Second
	// expirerMaxSleep caps one sleep: a self-heal for a wake that was lost.
	expirerMaxSleep = 10 * time.Minute
	// expirerRetryAfterError is the sleep after a failed read or sweep.
	expirerRetryAfterError = 30 * time.Second
	// expirerBatch bounds one ListExpiredCustomStatuses read.
	expirerBatch = 200
)

// customStatusExpiryStore is the slice of Store the expirer reads and writes.
type customStatusExpiryStore interface {
	NextCustomStatusExpiry(ctx context.Context) (string, bool, error)
	ListExpiredCustomStatuses(ctx context.Context, now string, limit int) ([]db.ExpiredCustomStatus, error)
	ClearCustomStatusIfExpiry(ctx context.Context, userID int64, expiresAt string) (bool, error)
}

// CustomStatusNotifier is told when the expirer cleared a user's custom status.
// expiresAt is the expiry the cleared row carried: the hub acts only on a
// connection whose live status still carries that same tag.
type CustomStatusNotifier interface {
	CustomStatusExpired(userID int64, expiresAt string)
}

// CustomStatusExpirer clears custom statuses at their expiry: one goroutine
// (Run) sleeps until the soonest pending expiry, then compare-and-clears every
// expired row and tells the notifier about each row it really cleared.
type CustomStatusExpirer struct {
	st   customStatusExpiryStore
	wake chan struct{} // size 1: a status with an expiry was just set

	mu       syncutil.Mutex
	notifier CustomStatusNotifier

	// Timing knobs; tests shorten them.
	now        func() time.Time
	slack      time.Duration
	maxSleep   time.Duration
	retryAfter time.Duration
}

// NewCustomStatusExpirer returns an expirer over st. Install the notifier with
// SetNotifier before Run.
func NewCustomStatusExpirer(st customStatusExpiryStore) *CustomStatusExpirer {
	return &CustomStatusExpirer{
		st:         st,
		wake:       make(chan struct{}, 1),
		now:        time.Now,
		slack:      expirerSlack,
		maxSleep:   expirerMaxSleep,
		retryAfter: expirerRetryAfterError,
	}
}

// SetNotifier installs the notifier a cleared status is reported to.
func (e *CustomStatusExpirer) SetNotifier(n CustomStatusNotifier) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.notifier = n
}

// Wake makes Run re-read the soonest expiry. It never blocks: a wake already
// pending covers this one.
func (e *CustomStatusExpirer) Wake() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// Sweep clears every expired custom status once and returns the first error.
func (e *CustomStatusExpirer) Sweep(ctx context.Context) error {
	e.mu.Lock()
	notifier := e.notifier
	e.mu.Unlock()
	for {
		now := e.now().UTC().Format(dbtime.ISOLayout)
		rows, err := e.st.ListExpiredCustomStatuses(ctx, now, expirerBatch)
		if err != nil {
			return fmt.Errorf("list expired custom statuses: %w", err)
		}
		cleared := 0
		for _, r := range rows {
			ok, err := e.st.ClearCustomStatusIfExpiry(ctx, r.UserID, r.ExpiresAt)
			if err != nil {
				return fmt.Errorf("clear expired custom status for user %d: %w", r.UserID, err)
			}
			if !ok {
				continue
			}
			cleared++
			if notifier != nil {
				notifier.CustomStatusExpired(r.UserID, r.ExpiresAt)
			}
		}
		// A full batch with progress may have more behind it; anything else is done. Rows
		// that did not clear were changed by a concurrent set and are re-evaluated by the
		// next read. Returning when a full batch clears nothing is correct, not a stall:
		// every row was re-set with a future expiry between list and clear, so it no longer
		// matches ListExpiredCustomStatuses, and nextSleep re-reads the soonest expiry.
		if len(rows) < expirerBatch || cleared == 0 {
			return nil
		}
	}
}

// Run is the expirer loop. It returns when ctx is done.
func (e *CustomStatusExpirer) Run(ctx context.Context) {
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
			// A status with an expiry was set: re-read the soonest deadline.
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
			slog.Warn("custom status expirer: sweep failed", "err", err)
			e.sleepOrDone(ctx, e.retryAfter)
		}
	}
}

// sleepOrDone waits d or until ctx is done.
func (e *CustomStatusExpirer) sleepOrDone(ctx context.Context, d time.Duration) {
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
func (e *CustomStatusExpirer) nextSleep(ctx context.Context) (sleep time.Duration, failed bool) {
	next, ok, err := e.st.NextCustomStatusExpiry(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("custom status expirer: read next expiry failed", "err", err)
		}
		return e.retryAfter, true
	}
	if !ok {
		return e.maxSleep, false
	}
	at, err := time.Parse(dbtime.ISOLayout, next)
	if err != nil {
		slog.Warn("custom status expirer: unparseable expiry", "expires_at", next, "err", err)
		return e.retryAfter, false
	}
	sleep = at.Add(e.slack).Sub(e.now())
	return min(max(sleep, 0), e.maxSleep), false
}
