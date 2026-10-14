package main

import (
	"os/exec"
	"slices"
	"testing"
)

// reclaimPort stops a failed phase's leftover replacement by its working
// directory. A process started in one of the run's install directories is
// found; one started anywhere else is not.
func TestStrayServersMatchesOnlyTheRunsDirectories(t *testing.T) {
	ours, other := t.TempDir(), t.TempDir()
	start := func(dir string) int {
		cmd := exec.Command("sleep", "30")
		cmd.Dir = dir
		if err := cmd.Start(); err != nil {
			t.Fatalf("starting sleep: %v", err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd.Process.Pid
	}
	mine, theirs := start(ours), start(other)

	got := strayServers([]string{ours})
	if !slices.Contains(got, mine) {
		t.Errorf("strayServers = %v, want it to include %d, started in the run's directory", got, mine)
	}
	if slices.Contains(got, theirs) {
		t.Errorf("strayServers = %v, want it to leave %d alone, started elsewhere", got, theirs)
	}
}
