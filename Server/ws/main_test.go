package ws_test

import (
	"fmt"
	"os"
	"testing"

	"go.uber.org/goleak"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// TestMain fails the run on a lock rank violation even when the panic was
// recovered on the way (the hub's dispatch loop and handlers recover them).
func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m, goleak.Cleanup(func(exitCode int) {
		if n := syncutil.TakeRankViolations(); n > 0 {
			fmt.Fprintf(os.Stderr, "FAIL: %d lock rank violation(s); see the reports above\n", n)
			if exitCode == 0 {
				exitCode = 1
			}
		}
		os.Exit(exitCode)
	}))
}
