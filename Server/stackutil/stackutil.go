// Package stackutil captures goroutine stacks for panic logging in a form safe
// to persist and stream. runtime.Stack embeds by-value argument words as raw
// hex, exposing secrets (E2EE keys, tokens, passwords) that flowed through a
// panicking call, and panic logs reach the admin ring buffer and SSE. Capture
// uses runtime.Callers + CallersFrames: function names and locations only.
package stackutil

import (
	"runtime"
	"strconv"
	"strings"
)

// Capture returns a compact, argument-free stack for the calling goroutine: a
// "func" line and a "\tfile:line" line per frame.
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
