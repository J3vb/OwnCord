package app

import (
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// bindRetryEvery spaces the bind retries; a var so the give-up test does not
// sleep ~10 seconds.
var bindRetryEvery = 500 * time.Millisecond

// serveWithBindRetry runs serve, retrying while the failure is an
// address-in-use bind conflict; ErrServerClosed and nil pass through as clean
// shutdowns.
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
