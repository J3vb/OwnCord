package admin

import (
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
)

// The admin panel has three actions that end in a process restart: applying a
// server update, restoring a database backup, and finishing the setup wizard
// with listener-affecting changes. None of them stop or spawn processes
// directly — they request a restart through the hook below, and the main
// package performs the actual work: trigger the same graceful drain a SIGTERM
// would (which also works on Windows, where a process cannot signal itself),
// and only after run() has fully torn down either spawn the replacement
// binary or exit for the process supervisor to relaunch, per
// server.restart_mode (see Server/restart.go).

// restartSelf is the process-restart request hook. Swapped by
// SetRestartHandoff at startup and by tests (StubRestart); the default logs
// loudly instead of exiting, so a mis-wired binary degrades to "restart
// manually" rather than to a silent no-op or a test-killing os.Exit.
var (
	restartMu   sync.Mutex
	restartSelf = restartUnwired
)

func restartUnwired(reason string) {
	slog.Error("restart requested but no restart coordinator is wired — restart the server manually",
		"reason", reason)
}

// SetRestartHandoff wires restart requests to the main package's restart
// coordinator. Call once at startup, before the router serves (main.go, next
// to SetDatabasePath).
func SetRestartHandoff(fn func(reason string)) {
	restartMu.Lock()
	restartSelf = fn
	restartMu.Unlock()
}

// requestRestart invokes the current restart hook.
func requestRestart(reason string) {
	restartMu.Lock()
	fn := restartSelf
	restartMu.Unlock()
	fn(reason)
}

// restartState serializes the restart-ending admin actions against each
// other. Two problems it closes: concurrent update applies raced the same
// staged .new file (each download deletes the other's staged file, and the
// loser broadcast a spurious update_aborted to every client while a restart
// was actually happening), and a restore could tear the database down under
// an apply that had already responded 200.
//
//	idle ──beginRestartSensitiveOp──▶ busy ──commitRestartPending──▶ pending
//	  ▲                                │
//	  └────abortRestartSensitiveOp─────┘
//
// pending is terminal: it means a restart request has been (or is about to
// be) issued and only the process replacement clears it. Ownership of the
// busy state transfers to the background goroutine that finishes the work —
// the HTTP handler responds while the state is still busy, so it must NOT
// defer a reset.
const (
	restartStateIdle    int32 = 0
	restartStateBusy    int32 = 1 // an update apply or restore is in flight
	restartStatePending int32 = 2 // a restart has been requested
)

var restartState atomic.Int32

// beginRestartSensitiveOp claims the exclusive restart-sensitive slot.
// Callers that fail any later step must release it with
// abortRestartSensitiveOp; callers that reach the point of no return promote
// it with commitRestartPending.
func beginRestartSensitiveOp() bool {
	return restartState.CompareAndSwap(restartStateIdle, restartStateBusy)
}

// abortRestartSensitiveOp releases the slot after a failed operation. CAS,
// not a blind store: an abort must never demote an already-pending restart.
func abortRestartSensitiveOp() {
	restartState.CompareAndSwap(restartStateBusy, restartStateIdle)
}

// commitRestartPending marks the process as committed to restarting.
func commitRestartPending() {
	restartState.Store(restartStatePending)
}

// tryDirectRestartPending is commitRestartPending for paths with no failable
// work between claiming the slot and requesting the restart (setup wizard):
// idle → pending in one step. Reports whether the claim won.
func tryDirectRestartPending() bool {
	return restartState.CompareAndSwap(restartStateIdle, restartStatePending)
}

// writeRestartConflict answers a request that lost to an in-flight
// restart-sensitive operation, distinguishing "busy, try again shortly" from
// "the process is about to be replaced".
func writeRestartConflict(w http.ResponseWriter) {
	if restartState.Load() == restartStatePending {
		writeErr(w, http.StatusConflict, "RESTART_PENDING",
			"the server is restarting — retry after it comes back")
		return
	}
	writeErr(w, http.StatusConflict, "UPDATE_IN_PROGRESS",
		"another update or restore is already in progress")
}
