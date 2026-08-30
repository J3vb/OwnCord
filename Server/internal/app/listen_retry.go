package app

import (
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// serveWithBindRetry runs serve, retrying bounded times while the failure is
// an address-in-use bind conflict. http.ErrServerClosed (and nil) pass
// straight through — those are clean shutdowns, not failures.
//
// This is a safety net, not part of the restart design: the restart handoff
// releases the port before the successor starts (Server/restart.go), so the
// retry only matters for external squatters, supervisor relaunch races
// against a not-yet-dead predecessor, and platform TIME_WAIT edge cases.
// bindRetryEvery spaces the bind retries; a var only so the give-up-bound
// test doesn't sleep the real ~10 seconds.
var bindRetryEvery = 500 * time.Millisecond

func serveWithBindRetry(log *slog.Logger, label string, serve func() error) error {
	const attempts = 20
	var err error
	for attempt := range attempts {
		err = serve()
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			return err
		}
		if attempt < attempts-1 && isAddrInUse(err) {
			log.Warn("port in use, retrying...", "listener", label, "attempt", attempt+1, "error", err)
			time.Sleep(bindRetryEvery)
			continue
		}
		break
	}
	return err
}
