package admin_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestApplyUpdate_DrainDuringCountdownAbortsSwap pins the 4.5b hand-off: a
// shutdown that begins while the restart countdown runs must not swap the
// binary or ask for a restart. applyAndRestart watches the group's Draining
// signal, not the job ctx, because the group cancels that ctx only after its
// grace; watching the ctx would let the countdown finish and the swap commit
// during the grace.
func TestApplyUpdate_DrainDuringCountdownAbortsSwap(t *testing.T) {
	exePath, newPath, stagedHash := stageFakeUpdate(t)

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	admin.ResetRestartState()
	admin.ForceRestartState(true) // the handler claims busy before spawning the tail
	t.Cleanup(admin.ResetRestartState)
	reasons, restoreHook := admin.StubRestartCapture()
	defer restoreHook()
	// A countdown far longer than the test: only the drain can end it.
	defer admin.SetApplyRestartDelay(time.Hour)()

	const actor int64 = 7
	bg := syncutil.NewGroup(context.Background())
	hub := &mockHub{}
	if !bg.Go(context.Background(), func(ctx context.Context) {
		admin.ApplyAndRestart(ctx, database, actor, "v9.9.9", hub, exePath, newPath, stagedHash, admin.NewStopSignal(bg.Draining(), nil))
	}) {
		t.Fatal("Go refused the apply tail on a live group")
	}

	// The 5 s grace is generous on purpose: the tail must return on the drain
	// alone, so Stop reports no stragglers and returns well inside it.
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if n := bg.Stop(ctx, 5*time.Second); n != 0 {
		t.Fatalf("Stop left %d stragglers, want the tail to end on the drain", n)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Errorf("Stop took %v, want the tail to end on the drain, not at the grace", took)
	}

	if got, err := os.ReadFile(exePath); err != nil || string(got) != "old binary" {
		t.Errorf("exePath contents = %q, err=%v; want the binary unchanged", got, err)
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Errorf("staged file gone after an aborted swap (stat err=%v)", err)
	}
	if olds := oldBinaries(t, exePath); len(olds) != 0 {
		t.Errorf("old binaries = %v, want none: nothing was swapped", olds)
	}
	if got := reasons(); len(got) != 0 {
		t.Errorf("restart hook reasons = %v, want none: a draining process must not request a restart", got)
	}
	if got := admin.CurrentRestartState(); got != "idle" {
		t.Errorf("restart state = %q, want idle: the slot must be released", got)
	}

	if len(hub.restartCalls) != 1 || hub.restartCalls[0].reason != ws.RestartReasonUpdate {
		t.Errorf("restartCalls = %+v, want exactly the countdown broadcast and no corrective one", hub.restartCalls)
	}

	var rows int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM audit_log WHERE action = 'update_failed' AND actor_id = ? AND target_type = 'server'`,
		actor).Scan(&rows); err != nil {
		t.Fatalf("reading the audit log: %v", err)
	}
	if rows != 1 {
		t.Errorf("update_failed rows = %d, want 1", rows)
	}
}

// TestApplyUpdate_ShutdownBeforeGroupDrainAbortsSwap is the SIGTERM case: the
// process-wide shutdown signal closes at the start of App.Close, while the
// background group is still open (its Draining closes seven steps later,
// after a hub-notice wait that lasts 5 s with a client connected). The
// countdown must end on the shutdown signal alone, with the group untouched.
func TestApplyUpdate_ShutdownBeforeGroupDrainAbortsSwap(t *testing.T) {
	exePath, newPath, stagedHash := stageFakeUpdate(t)
	admin.ResetRestartState()
	admin.ForceRestartState(true)
	t.Cleanup(admin.ResetRestartState)
	reasons, restoreHook := admin.StubRestartCapture()
	defer restoreHook()
	defer admin.SetApplyRestartDelay(time.Hour)()

	bg := syncutil.NewGroup(context.Background())
	shutdown := make(chan struct{})
	hub := &mockHub{}
	done := make(chan struct{})
	if !bg.Go(context.Background(), func(ctx context.Context) {
		defer close(done)
		admin.ApplyAndRestart(ctx, nil, 0, "v9.9.9", hub, exePath, newPath, stagedHash, admin.NewStopSignal(bg.Draining(), shutdown))
	}) {
		t.Fatal("Go refused the apply tail on a live group")
	}
	close(shutdown) // the group is NOT stopped
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the countdown ignored the shutdown signal and kept waiting")
	}
	if got, err := os.ReadFile(exePath); err != nil || string(got) != "old binary" {
		t.Errorf("exePath contents = %q, err=%v; want the binary unchanged", got, err)
	}
	if got := reasons(); len(got) != 0 {
		t.Errorf("restart hook reasons = %v, want none", got)
	}
	if got := admin.CurrentRestartState(); got != "idle" {
		t.Errorf("restart state = %q, want idle", got)
	}
}

// A shutdown landing between the countdown and the first rename still aborts:
// applyStagedUpdate re-checks right before it touches the disk.
func TestApplyStagedUpdate_ShutdownBeforeRenameLeavesBinary(t *testing.T) {
	exePath, newPath, stagedHash := stageFakeUpdate(t)
	if admin.ApplyStagedUpdate(&mockHub{}, exePath, newPath, stagedHash, func() bool { return true }) {
		t.Fatal("ApplyStagedUpdate = true, want the swap refused during a shutdown")
	}
	if got, err := os.ReadFile(exePath); err != nil || string(got) != "old binary" {
		t.Errorf("exePath contents = %q, err=%v; want the binary unchanged", got, err)
	}
	if olds := oldBinaries(t, exePath); len(olds) != 0 {
		t.Errorf("old binaries = %v, want none", olds)
	}
}
