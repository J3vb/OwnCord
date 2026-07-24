// Package stackutil captures goroutine stack traces for panic logging in a
// form that is safe to persist and stream.
//
// runtime.Stack embeds function argument values as raw hex words. For
// arguments passed by value (e.g. a [32]byte room key or a [16]byte IV) that
// exposes the actual bytes — secret material such as E2EE keys, session
// tokens, or passwords that flowed through a panicking call. Because the
// server tees panic logs into the admin ring buffer and streams them over SSE,
// a single panic on a crypto or auth path could leak keys to any admin viewer.
//
// Capture avoids this by using runtime.Callers + CallersFrames, which yields
// only function names and source locations — never argument data.
package stackutil

import (
	"runtime"
	"strconv"
	"strings"
)

// Capture returns a compact, argument-free stack trace for the calling
// goroutine: one "func" line followed by a "\tfile:line" line per frame. It is
// safe to log even when the panicking function held sensitive arguments.
func Capture() string {
	pcs := make([]uintptr, 64)
	n := runtime.Callers(2, pcs) // skip runtime.Callers and Capture itself
	if n == 0 {
		return ""
	}
	frames := runtime.CallersFrames(pcs[:n])
	var b strings.Builder
	for {
		f, more := frames.Next()
		b.WriteString(f.Function)
		b.WriteString("\n\t")
		b.WriteString(f.File)
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(f.Line))
		b.WriteByte('\n')
		if !more {
			break
		}
	}
	return b.String()
}
