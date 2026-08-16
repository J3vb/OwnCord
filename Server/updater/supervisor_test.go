package updater

import "testing"

// Non-empty INVOCATION_ID (systemd) or NSSM_SERVICE_NAME (NSSM) means
// supervised; empty counts as unset. Both are pinned empty in the negative
// case because CI runners themselves can execute under systemd and carry a
// real INVOCATION_ID into the test process.
func TestRunningUnderSupervisor(t *testing.T) {
	cases := []struct {
		name         string
		invocationID string
		nssmService  string
		want         bool
	}{
		{"bare (both empty)", "", "", false},
		{"systemd", "4a1f3b0e9c8d4e2f8a7b6c5d4e3f2a1b", "", true},
		{"nssm", "", "OwnCord", true},
		{"both", "abc", "OwnCord", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// t.Setenv with "" makes the variable present-but-empty, which the
			// non-empty check treats exactly like unset — the same trick
			// container_test.go relies on for hermetic negatives.
			t.Setenv("INVOCATION_ID", tc.invocationID)
			t.Setenv("NSSM_SERVICE_NAME", tc.nssmService)
			if got := RunningUnderSupervisor(); got != tc.want {
				t.Errorf("RunningUnderSupervisor() = %v, want %v (INVOCATION_ID=%q NSSM_SERVICE_NAME=%q)",
					got, tc.want, tc.invocationID, tc.nssmService)
			}
		})
	}
}
