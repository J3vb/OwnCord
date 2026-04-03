package api_test

import (
	"testing"

	"go.uber.org/goleak"
)

func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m,
		// Hub.Run starts long-lived goroutines that are stopped via Hub.Stop().
		// API tests create routers (which start hubs) but don't always call
		// Stop() — these are expected background goroutines, not leaks.
		goleak.IgnoreTopFunction("github.com/owncord/server/ws.(*Hub).Run.func1"),
	)
}
