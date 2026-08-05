package updater

import (
	"os"
	"testing"
)

// The env var is authoritative in both directions; the marker-file fallback
// only applies when the variable is absent entirely.
func TestRunningInContainer_EnvSemantics(t *testing.T) {
	cases := []struct {
		name string
		val  string
		want bool
	}{
		{"set to 1", "1", true},
		{"set to true", "true", true},
		{"arbitrary truthy value", "podman", true},
		{"explicit opt-out 0", "0", false},
		{"explicit opt-out false", "false", false},
		{"explicit opt-out FALSE", "FALSE", false},
		{"empty string reads as unset-like opt-out", "", false},
		{"whitespace only", "   ", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OWNCORD_CONTAINER", tc.val)
			if got := RunningInContainer(); got != tc.want {
				t.Errorf("RunningInContainer() with OWNCORD_CONTAINER=%q = %v, want %v", tc.val, got, tc.want)
			}
		})
	}
}

// With the variable absent, the answer comes from the engine marker files —
// which do not exist on CI runners or dev machines, so this pins the
// bare-metal default. (The marker-present path is exercised for real in
// every container deployment; the file list is data, not logic.)
func TestRunningInContainer_BareMetalDefault(t *testing.T) {
	orig, had := os.LookupEnv("OWNCORD_CONTAINER")
	_ = os.Unsetenv("OWNCORD_CONTAINER")
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("OWNCORD_CONTAINER", orig)
		}
	})
	if RunningInContainer() {
		t.Skip("environment reports a container marker — running inside a container, default untestable here")
	}
}
