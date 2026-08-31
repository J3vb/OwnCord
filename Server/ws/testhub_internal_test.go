package ws

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// newTestHub mirrors the pre-B3-4 NewHub(database, limiter, svc) shape so the
// seventy-odd construction sites in this package did not each grow a struct
// literal (the plan's testHubOptions helper). A nil limiter gets a fresh
// in-memory one; svc stays as given — nil is the deliberately degraded
// fixture many tests build. Construction failure is a test bug, so it fatals.
func newTestHub(tb testing.TB, database *db.DB, limiter *auth.RateLimiter, svc *service.Services) *Hub {
	tb.Helper()
	if limiter == nil {
		limiter = auth.NewRateLimiter()
	}
	return newTestHubWith(tb, HubOptions{DB: database, Limiter: limiter, Services: svc})
}

// newTestHubWith is the options-shaped variant for the sites that used to
// call a pre-Run setter (SetLiveKit, SetLiveKitProcess, SetPluginRegistry,
// ConfigureReplay) after construction.
func newTestHubWith(tb testing.TB, opts HubOptions) *Hub {
	tb.Helper()
	if opts.Limiter == nil {
		opts.Limiter = auth.NewRateLimiter()
	}
	if opts.Settings == nil && opts.DB != nil {
		opts.Settings = service.NewSettingsService(opts.DB)
	}
	h, err := NewHub(opts)
	if err != nil {
		tb.Fatalf("NewHub: %v", err)
	}
	return h
}
