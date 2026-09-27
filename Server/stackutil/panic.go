package stackutil

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

// memoryFaultMessage is the message the Go runtime attaches to both a nil
// pointer dereference (runtime.panicmem) and an invalid address fault
// (runtime.panicmemAddr). Matching it is what distinguishes a memory fault
// from every other runtime.Error (a divide by zero, a slice bounds panic).
const memoryFaultMessage = "runtime error: invalid memory address or nil pointer dereference"

// isMemoryFault reports whether rec is a runtime.Error describing a nil
// dereference or an invalid address.
func isMemoryFault(rec any) bool {
	err, ok := rec.(error)
	if !ok {
		return false
	}
	var rerr runtime.Error
	if !errors.As(err, &rerr) {
		return false
	}
	return strings.Contains(err.Error(), memoryFaultMessage)
}

// hardwareFaultOn is the platform decision, split out so it can be tested for
// every OS from any host. Only Windows exits: there a recovered access
// violation can leave the heap corrupt (golang/go#81238), so continuing with
// unknown memory state is worse than a supervisor restart. Everywhere else
// the same nil deref is an ordinary software fault and stays recoverable.
func hardwareFaultOn(goos string, rec any) bool {
	return goos == "windows" && isMemoryFault(rec)
}

// HardwareFault reports whether rec is a panic the process must exit on
// rather than recover from on THIS host — the classifier the recovery sites
// hand the panic value to (SRE-08). Remove the Windows rule once a Go release
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

// SetPanicRecorder installs the callback told the time of every recovered
// panic; nil clears it. The composition root (internal/app) sets it at boot
// so the boot marker can name the last recovered panic. It is a process-global
// because the recovery sites live in packages (ws, api) that must not depend
// on internal/app.
func SetPanicRecorder(fn func(time.Time)) {
	recorderMu.Lock()
	defer recorderMu.Unlock()
	panicRecorder = fn
}

// SetFatal replaces the process exit hook the recovery sites use on a hardware
// fault. Production leaves the default (os.Exit(1)); tests substitute a
// recorder to prove the exit was requested without killing the test binary.
func SetFatal(fn func()) {
	fatalMu.Lock()
	defer fatalMu.Unlock()
	fatalFn = fn
}

// Fatal runs the installed exit hook. A hardware fault is the only caller, so
// a supervisor restarts the process rather than it continuing on possibly
// damaged memory.
func Fatal() {
	fatalMu.Lock()
	fn := fatalFn
	fatalMu.Unlock()
	fn()
}

// Recovered is the one call a recovery site makes with its recovered value:
// it records the panic for the boot marker and reports whether rec is a
// hardware fault on this host (HardwareFault). A true return means the caller
// must exit — through its own fatal hook where it has one (the hub's panic
// breaker), or Fatal otherwise — and must not resume the recovered path. A
// false return leaves the panic recovered exactly as before.
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
