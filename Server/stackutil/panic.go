package stackutil

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

// memoryFaultMessage is the runtime message of both a nil dereference and an
// invalid address fault; matching it separates a memory fault from other runtime.Errors.
const memoryFaultMessage = "runtime error: invalid memory address or nil pointer dereference"

// isMemoryFault reports whether rec is a runtime.Error for a nil dereference or invalid address.
func isMemoryFault(rec any) bool {
	err, ok := rec.(error)
	if !ok {
		return false
	}
	if _, ok := errors.AsType[runtime.Error](err); !ok {
		return false
	}
	return strings.Contains(err.Error(), memoryFaultMessage)
}

// hardwareFaultOn is the per-OS decision, split out so tests can cover every OS.
// Only Windows exits: a recovered access violation can leave the heap corrupt
// (golang/go#81238), so a supervisor restart beats continuing; elsewhere the
// same nil deref is an ordinary recoverable fault.
func hardwareFaultOn(goos string, rec any) bool {
	return goos == "windows" && isMemoryFault(rec)
}

// HardwareFault reports whether rec is a panic the process must exit on rather
// than recover from on THIS host. Remove the Windows rule once a Go release
// carries the golang/go#81238 fix.
func HardwareFault(rec any) bool {
	return hardwareFaultOn(runtime.GOOS, rec)
}

var (
	recorderMu    sync.Mutex
	panicRecorder func(time.Time)

	fatalMu sync.Mutex
	fatalFn = func() { os.Exit(1) }
)

// SetPanicRecorder installs the callback told the time of every recovered panic
// (nil clears it), so the boot marker can name the last one. It is a
// process-global because ws and api must not depend on internal/app.
func SetPanicRecorder(fn func(time.Time)) {
	recorderMu.Lock()
	defer recorderMu.Unlock()
	panicRecorder = fn
}

// SetFatal replaces the exit hook used on a hardware fault; production keeps os.Exit(1), tests substitute a
// recorder.
func SetFatal(fn func()) {
	fatalMu.Lock()
	defer fatalMu.Unlock()
	fatalFn = fn
}

// Fatal runs the exit hook, so a supervisor restarts the process rather than it continuing on damaged memory.
func Fatal() {
	fatalMu.Lock()
	fn := fatalFn
	fatalMu.Unlock()
	fn()
}

// Recovered is the one call a recovery site makes: it records the panic for the
// boot marker and reports whether rec is a hardware fault on this host. True
// means the caller must exit (via its own fatal hook if it has one, else Fatal)
// and not resume; false leaves the panic recovered as before.
func Recovered(rec any) bool {
	at := time.Now()
	recorderMu.Lock()
	fn := panicRecorder
	recorderMu.Unlock()
	if fn != nil {
		fn(at)
	}
	return HardwareFault(rec)
}
