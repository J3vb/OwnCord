package livekitproc

import (
	"context"
	"log/slog"
	"time"
)

// restartTiming is the backoff: the fast tier doubles baseDelay up to maxDelay and gives up after maxRetries
// exits within stableAfter of start; the slow tier then retries every slowRetry.
type restartTiming struct {
	baseDelay   time.Duration
	maxDelay    time.Duration
	maxRetries  int
	stableAfter time.Duration
	slowRetry   time.Duration
}

var defaultRestartTiming = restartTiming{
	baseDelay:   3 * time.Second,
	maxDelay:    60 * time.Second,
	maxRetries:  10,
	stableAfter: 30 * time.Second,
	slowRetry:   10 * time.Minute,
}

// slowRetry parks runLoop after the fast tier gave up, so a short-lived cause
// (a held port, a full disk) does not keep voice down until restart. manual is
// true when Restart woke it; ok is false when the loop must exit.
func (p *Process) slowRetry(ctx context.Context, rapidFailures int) (manual, ok bool) {
	wait := p.timing.slowRetry
	if !p.gaveUp.Swap(true) {
		slog.Error("livekit: too many rapid failures, retrying every 10 minutes",
			"rapid_failures", rapidFailures, "retry_in", wait)
	}

	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return false, false
	}
	p.nextRetry = time.Now().Add(wait)
	p.mu.Unlock()

	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-p.kick:
		manual = true
	case <-ctx.Done():
	}

	// Clear the wait and drain a late wake under the lock Restart sends with.
	p.mu.Lock()
	p.nextRetry = time.Time{}
	select {
	case <-p.kick:
		manual = true
	default:
	}
	stopped := p.stopped
	p.mu.Unlock()

	if stopped || ctx.Err() != nil {
		return false, false
	}
	if manual {
		slog.Info("livekit: restart requested by an admin")
	} else {
		slog.Warn("livekit: trying again after giving up")
	}
	return manual, true
}

// Restart gives a supervisor that stopped restarting the full set of quick
// retries again. It reports false when there is nothing to restart (running,
// still in quick retries, stopped, or externally managed).
func (p *Process) Restart() bool {
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopped || p.nextRetry.IsZero() {
		return false
	}
	select {
	case p.kick <- struct{}{}:
	default:
		// A wake is already queued; this press joins it.
	}
	return true
}
