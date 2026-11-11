package admin

import (
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/httperr"
)

// Three admin actions end in a process restart (server update, backup restore, setup wizard with
// listener-affecting changes). None stops or spawns processes itself: each requests a restart through the
// hook below and the main package runs the same graceful drain a SIGTERM would (it works on Windows, where a
// process cannot signal itself), then after run() tears down either spawns the replacement or exits for the
// supervisor, per server.restart_mode (Server/internal/app/restart.go).

// restartSelf is the restart request hook, swapped by SetRestartHandoff and tests (StubRestart). The default
// logs loudly instead of exiting, so a mis-wired binary degrades to "restart manually", not a silent no-op or
// a test-killing os.Exit.
var (
	restartMu   sync.Mutex
	restartSelf = restartUnwired
)

func restartUnwired(reason string) {
	slog.Error("restart requested but no restart coordinator is wired — restart the server manually",
		"reason", reason)
}

// SetRestartHandoff wires restart requests to the main package's coordinator; call once at startup before the
// router serves.
func SetRestartHandoff(fn func(reason string)) {
	restartMu.Lock()
	restartSelf = fn
	restartMu.Unlock()
}

func requestRestart(reason string) {
	restartMu.Lock()
	fn := restartSelf
	restartMu.Unlock()
	fn(reason)
}

// restartState serializes the restart-ending admin actions: concurrent update applies would race the same
// staged .new file (each download deletes the other's, and the loser broadcast a spurious update_aborted
// during a real restart), and a restore could tear the database down under an apply that already responded
// 200.
//
//	idle ──beginRestartSensitiveOp──▶ busy ──commitRestartPending──▶ pending
//	  ▲                                │
//	  └────abortRestartSensitiveOp─────┘
//
// pending is terminal: a restart has been (or is about to be) requested and only process replacement clears
// it. Busy-state ownership transfers to the background goroutine that finishes the work; the handler responds
// while busy, so it must NOT defer a reset.
const (
	restartStateIdle    int32 = 0
	restartStateBusy    int32 = 1 // an update apply or restore is in flight
	restartStatePending int32 = 2 // a restart has been requested
)

var restartState atomic.Int32

// beginRestartSensitiveOp claims the exclusive slot. A caller failing later must release it with
// abortRestartSensitiveOp; one past the point of no return promotes it with commitRestartPending.
func beginRestartSensitiveOp() bool {
	return restartState.CompareAndSwap(restartStateIdle, restartStateBusy)
}

// abortRestartSensitiveOp releases the slot after a failed operation. CAS,
// not a blind store: an abort must never demote an already-pending restart.
func abortRestartSensitiveOp() {
	restartState.CompareAndSwap(restartStateBusy, restartStateIdle)
}

func commitRestartPending() {
	restartState.Store(restartStatePending)
}

// tryDirectRestartPending is commitRestartPending for paths with no failable work between claim and request
// (setup wizard): idle → pending in one step; reports whether the claim won.
func tryDirectRestartPending() bool {
	return restartState.CompareAndSwap(restartStateIdle, restartStatePending)
}

// writeRestartConflict answers a request that lost to an in-flight restart-sensitive operation: "busy, try
// again" versus "process about to be replaced".
func writeRestartConflict(w http.ResponseWriter) {
	if restartState.Load() == restartStatePending {
		writeErr(w, http.StatusConflict, httperr.CodeRestartPending,
			"the server is restarting — retry after it comes back")
		return
	}
	writeErr(w, http.StatusConflict, httperr.CodeUpdateInProgress,
		"another update or restore is already in progress")
}
