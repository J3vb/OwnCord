package config_test

import "testing"

// mustDo fails the test, naming the operation, when err is non-nil.
func mustDo(t testing.TB, operation string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", operation, err)
	}
}
