package ws

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// hubLifecycle groups run, stop and sweep-guard state. It holds a sync.Once, WaitGroup and atomics,
// so never copy it: keep it a value field of Hub (h.lifecycle).
type hubLifecycle struct {
	stopOnce     sync.Once
	gracefulOnce sync.Once

	restartGate restartNoticeGate // dedupes BroadcastServerRestart

	// running flips when Run starts; tests wait on it via RunningForTest.
	running atomic.Bool

	// dispatchExited flips when Run returns for good (Stop or the panic breaker). /health reads it
	// via DispatchAlive: clients still register through registerNow with the loop dead, so nothing
	// else makes the outage observable.
	dispatchExited atomic.Bool

	// runDone closes when Run returns, after dispatchExited is set and its sweeps returned. Stop
	// only signals the loop; whoever started Run joins it here (Done). Nil on struct-literal hubs
	// in tests.
	runDone chan struct{}

	// ctx is cancelled by closeStop; sweeps and background work (voice-leave cleanup, joined by
	// JoinBackground) run under it.
	ctx        context.Context
	cancel     context.CancelFunc
	sweeps     sync.WaitGroup
	background *syncutil.Group

	// fatalFn runs when the panic breaker trips (3 panics/60s): state is unknown, so production
	// exits for the supervisor rather than serve connections that can never get a broadcast. Tests
	// replace it.
	fatalFn func()

	// In-flight guards for the DB-heavy sweeps (startSweep): a tick during a running sweep is
	// skipped, not stacked.
	sessionSweepInFlight                                         atomic.Bool
	voiceSweepInFlight, voiceReconcileInFlight, afkSweepInFlight atomic.Bool
}
