package admin

import "time"

// logStreamRecheckEvery is how often a stream re-checks its viewer for live lines. A check is three DB reads;
// per line, a busy server spent hundreds of reads a second. A revoked viewer sees at most this much extra
// output; backfill chunks and keepalives still check every time.
const logStreamRecheckEvery = time.Second

// throttledCheck wraps check so live lines call it at most once per every. Construction time counts as the
// last check (the stream was just authorized); once check returns false it returns false forever. Only the
// stream's own goroutine calls it, so it takes no lock.
func throttledCheck(check func() bool, every time.Duration, now func() time.Time) func() bool {
	last := now()
	denied := false
	return func() bool {
		if denied {
			return false
		}
		if t := now(); t.Sub(last) >= every {
			last = t
			if !check() {
				denied = true
				return false
			}
		}
		return true
	}
}

// logStreamHooks lets tests drive the stream's clock and count principal resolutions; the zero value is
// production.
type logStreamHooks struct {
	now       func() time.Time
	onResolve func()
}
