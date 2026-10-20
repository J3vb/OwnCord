package admin_test

import (
	"testing"

	"go.uber.org/goleak"
	"golang.org/x/crypto/bcrypt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/updater"
)

func TestMain(m *testing.M) {
	// Password hashing dominates this suite's runtime at the production cost
	// of 12; nothing under test depends on hash strength.
	auth.SetCostForTesting(bcrypt.MinCost)
	// Tests that reach the real release host leave an idle keep-alive
	// connection on the updater's shared transport.
	goleak.VerifyTestMain(m, goleak.Cleanup(func(int) { updater.CloseIdleConnections() }))
}
