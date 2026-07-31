package api_test

import (
	"testing"

	"go.uber.org/goleak"
	"golang.org/x/crypto/bcrypt"

	"github.com/owncord/server/auth"
)

func TestMain(m *testing.M) {
	// Password hashing dominates this suite's runtime at the production cost
	// of 12; nothing under test depends on hash strength.
	auth.SetCostForTesting(bcrypt.MinCost)
	goleak.VerifyTestMain(m,
		// Hub.Run starts long-lived goroutines that are stopped via Hub.Stop().
		// API tests create routers (which start hubs) but don't always call
		// Stop() — these are expected background goroutines, not leaks.
		goleak.IgnoreTopFunction("github.com/owncord/server/ws.(*Hub).Run.func1"),
	)
}
