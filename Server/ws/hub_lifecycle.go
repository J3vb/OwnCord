package ws

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// hubLifecycle groups the Hub's run, stop and sweep-guard state. It holds a
// sync.Once, a WaitGroup and atomics, so it must never be copied: keep it a value
// field of Hub and reach it through h.lifecycle.
type hubLifecycle struct {
	stopOnce     sync.Once
	gracefulOnce sync.Once

	restartGate restartNoticeGate // dedupes BroadcastServerRestart

	// running flips when Run starts; tests read it via RunningForTest to wait for the
	// dispatch loop.
	running atomic.Bool

	// dispatchExited flips when Run returns for good (Stop or the panic breaker).
	// /health reads it via DispatchAlive: clients keep registering and appearing
	// online through registerNow even with the loop dead, so nothing else makes the
	// outage observable.
	dispatchExited atomic.Bool

	// runDone closes when Run returns, after dispatchExited is set and its sweeps
	// returned. Stop and GracefulStopContext only signal the loop; whoever started Run
	// joins it here (Done) before releasing what it reads. Made by NewHub; nil on
	// struct-literal hubs in internal tests.
	runDone chan struct{}

	// ctx is cancelled by closeStop; sweeps and background work (voice-leave cleanup,
	// joined by JoinBackground) run under it. Made by NewHub.
	ctx        context.Context
	cancel     context.CancelFunc
	sweeps     sync.WaitGroup
	background *syncutil.Group

	// fatalFn runs when the panic breaker trips (3 panics/60s). A hub that panicked
	// that often has unknown state, so production exits and lets the supervisor
	// restart rather than serve connections that can never receive a broadcast. Tests
	// replace it.
	fatalFn func()

	// In-flight guards for the DB-heavy sweeps (startSweep): a tick arriving while the
	// previous sweep runs is skipped, not stacked.
	sessionSweepInFlight                                         atomic.Bool
	voiceSweepInFlight, voiceReconcileInFlight, afkSweepInFlight atomic.Bool
}
