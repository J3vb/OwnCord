package stackutil

import (
	"errors"
	"runtime"
	"testing"
	"time"
)

// nilDerefPanic triggers a nil pointer dereference and returns the recovered
// panic value, which is the runtime.Error the classifier must recognise.
//
//go:noinline
func nilDerefPanic() (rec any) {
	defer func() { rec = recover() }()
	var p *int
	_ = *p
	return nil
}

// divideByZeroPanic returns a runtime.Error that is NOT a memory fault, to
// prove the classifier matches the memory message and not every runtime.Error.
//
//go:noinline
func divideByZeroPanic() (rec any) {
	defer func() { rec = recover() }()
	x, y := 1, 0
	_ = x / y
	return nil
}

// TestHardwareFault_Classifier pins the classifier SRE-08 hangs the
// supervisor-restart decision on: only a Windows nil-deref or invalid-address
// runtime.Error is a hardware fault that must exit. Every other panic —
// including the same runtime.Error on Linux, where it is an ordinary software
// fault — stays recoverable.
func TestHardwareFault_Classifier(t *testing.T) {
	mem := nilDerefPanic()
	if _, ok := mem.(runtime.Error); !ok {
		t.Fatalf("nil deref panic value is %T, want a runtime.Error", mem)
	}
	div := divideByZeroPanic()
	if _, ok := div.(runtime.Error); !ok {
		t.Fatalf("divide-by-zero panic value is %T, want a runtime.Error", div)
	}

	cases := []struct {
		name string
		goos string
		rec  any
		want bool
	}{
		{"windows nil deref", "windows", mem, true},
		{"windows divide by zero is software", "windows", div, false},
		{"windows string panic is software", "windows", "boom", false},
		{"windows error panic is software", "windows", errors.New("boom"), false},
		{"windows nil panic value", "windows", nil, false},
		{"linux nil deref stays recoverable", "linux", mem, false},
		{"darwin nil deref stays recoverable", "darwin", mem, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hardwareFaultOn(tc.goos, tc.rec); got != tc.want {
				t.Errorf("hardwareFaultOn(%q) = %v, want %v", tc.goos, got, tc.want)
			}
		})
	}
}

// TestHardwareFault_MatchesPlatform pins that the exported classifier is the
// platform-gated one: only Windows exits on a memory fault. On this (Linux)
// CI leg it is always false; the Windows leg exercises the true branch.
func TestHardwareFault_MatchesPlatform(t *testing.T) {
	mem := nilDerefPanic()
	if got, want := HardwareFault(mem), runtime.GOOS == "windows"; got != want {
		t.Errorf("HardwareFault on %s = %v, want %v", runtime.GOOS, got, want)
	}
}

// TestRecovered_RecordsEveryPanic pins the boot-marker half: Recovered always
// records the panic time, whether or not it also demands an exit.
func TestRecovered_RecordsEveryPanic(t *testing.T) {
	var recorded []time.Time
	SetPanicRecorder(func(at time.Time) { recorded = append(recorded, at) })
	t.Cleanup(func() { SetPanicRecorder(nil) })

	if Recovered("software") {
		t.Fatal("Recovered reported a software string panic as a hardware fault")
	}
	if len(recorded) != 1 {
		t.Fatalf("recorded %d panics, want 1 — a software panic must still reach the boot marker", len(recorded))
	}
}

// TestRecovered_NilRecorderIsSafe pins that a process with no installed
// recorder (a bare test binary) does not panic on the recovery path.
func TestRecovered_NilRecorderIsSafe(t *testing.T) {
	SetPanicRecorder(nil)
	if Recovered("software") {
		t.Fatal("Recovered reported a software panic as a hardware fault")
	}
}

// TestFatal_UsesTheInstalledHook pins that the exit hook is swappable so a
// test can prove an exit was requested without ending the test process.
func TestFatal_UsesTheInstalledHook(t *testing.T) {
	called := false
	SetFatal(func() { called = true })
	t.Cleanup(func() { SetFatal(func() {}) })
	Fatal()
	if !called {
		t.Fatal("Fatal did not run the installed hook")
	}
}
