package stackutil

import (
	"strings"
	"testing"
)

//go:noinline
func panicWithSecretArgs(key [32]byte, token string) {
	// key is passed by value, so runtime.Stack would render its bytes as hex.
	_ = key
	_ = token
	panic("boom")
}

// TestCaptureOmitsArguments is the security guard: Capture must never emit
// argument values. runtime.Stack renders by-value args as hex words ("0x..."),
// so asserting the output is free of hex verifies no argument bytes leaked,
// while still carrying the panicking function name and source location.
func TestCaptureOmitsArguments(t *testing.T) {
	var key [32]byte
	for i := range key {
		key[i] = 0xAB
	}

	var stack string
	func() {
		defer func() {
			if recover() != nil {
				stack = Capture()
			}
		}()
		panicWithSecretArgs(key, "super-secret-token")
	}()

	if stack == "" {
		t.Fatal("expected a captured stack after recover")
	}
	if strings.Contains(stack, "0x") {
		t.Errorf("captured stack contains hex argument words (possible secret leak):\n%s", stack)
	}
	if !strings.Contains(stack, "panicWithSecretArgs") {
		t.Errorf("captured stack missing the panicking function name:\n%s", stack)
	}
	if !strings.Contains(stack, "stackutil_test.go:") {
		t.Errorf("captured stack missing source location:\n%s", stack)
	}
}
