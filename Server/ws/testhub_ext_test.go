package ws_test

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// newTestHub is the package ws_test twin of the internal helper: the
// pre-B3-4 NewHub(database, limiter, svc) shape for this directory's
// external-package tests. A nil limiter gets a fresh in-memory one; nil svc
// stays the deliberately degraded fixture. Construction failure fatals.
func newTestHubDeps(tb testing.TB, database *db.DB, limiter *auth.RateLimiter, svc *service.Services) *ws.Hub {
	tb.Helper()
	if limiter == nil {
		limiter = auth.NewRateLimiter()
	}
	return newTestHubWith(tb, ws.HubOptions{DB: database, Limiter: limiter, Services: svc})
}

// newTestHubWith is the options-shaped variant for sites that used to call a
// pre-Run setter after construction.
func newTestHubWith(tb testing.TB, opts ws.HubOptions) *ws.Hub {
	tb.Helper()
	if opts.Limiter == nil {
		opts.Limiter = auth.NewRateLimiter()
	}
	if opts.Settings == nil && opts.DB != nil {
		opts.Settings = service.NewSettingsService(opts.DB)
	}
	h, err := ws.NewHub(opts)
	if err != nil {
		tb.Fatalf("ws.NewHub: %v", err)
	}
	return h
}
