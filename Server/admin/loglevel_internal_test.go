package admin

import (
	"log/slog"
	"testing"
	"time"
)

// The timed debug toggle (SRE-07): an operator raises the log level to debug
// for a bounded window, and it reverts on its own. A runaway boost must never
// outlive its window or survive a restart as the running level.

func TestLogLevelController_RaisesAndReverts(t *testing.T) {
	var lv slog.LevelVar
	lv.Set(slog.LevelInfo)
	c := NewLogLevelController(&lv, slog.LevelInfo)
	t.Cleanup(c.Close)

	revertAt, err := c.Set("debug", 300*time.Second)
	if err != nil {
		t.Fatalf("Set(debug): %v", err)
	}
	if lv.Level() != slog.LevelDebug {
		t.Fatalf("level = %v, want debug", lv.Level())
	}
	if revertAt.IsZero() {
		t.Fatal("revertAt is zero, want a deadline")
	}

	level, deadline := c.Current()
	if level != "debug" || deadline == nil {
		t.Fatalf("Current() = %q, %v; want debug and a deadline", level, deadline)
	}
}

func TestLogLevelController_RejectsUnknownLevel(t *testing.T) {
	var lv slog.LevelVar
	lv.Set(slog.LevelInfo)
	c := NewLogLevelController(&lv, slog.LevelInfo)
	t.Cleanup(c.Close)

	if _, err := c.Set("loud", 60*time.Second); err == nil {
		t.Fatal("Set(loud) = nil error, want a refusal")
	}
	if lv.Level() != slog.LevelInfo {
		t.Fatalf("level = %v after a rejected Set, want info unchanged", lv.Level())
	}
}

func TestLogLevelController_RevertsToBaseAfterWindow(t *testing.T) {
	var lv slog.LevelVar
	lv.Set(slog.LevelWarn)
	c := NewLogLevelController(&lv, slog.LevelWarn)
	t.Cleanup(c.Close)

	if _, err := c.Set("debug", 10*time.Millisecond); err != nil {
		t.Fatalf("Set(debug): %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for lv.Level() != slog.LevelWarn && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if lv.Level() != slog.LevelWarn {
		t.Fatalf("level = %v after the window, want the base warn back", lv.Level())
	}
	level, deadlinePtr := c.Current()
	if level != "warn" || deadlinePtr != nil {
		t.Fatalf("Current() = %q, %v after revert; want warn and no deadline", level, deadlinePtr)
	}
}

func TestLogLevelController_SecondSetReplacesTheFirst(t *testing.T) {
	var lv slog.LevelVar
	lv.Set(slog.LevelInfo)
	c := NewLogLevelController(&lv, slog.LevelInfo)
	t.Cleanup(c.Close)

	if _, err := c.Set("debug", 50*time.Millisecond); err != nil {
		t.Fatalf("Set(debug): %v", err)
	}
	if _, err := c.Set("warn", 10*time.Second); err != nil {
		t.Fatalf("Set(warn): %v", err)
	}
	// The first timer must not fire and yank the level back to info.
	time.Sleep(80 * time.Millisecond)
	if lv.Level() != slog.LevelWarn {
		t.Fatalf("level = %v, want the second Set's warn to stand", lv.Level())
	}
}

func TestLogLevelController_CloseStopsTheRevert(t *testing.T) {
	var lv slog.LevelVar
	lv.Set(slog.LevelInfo)
	c := NewLogLevelController(&lv, slog.LevelInfo)

	if _, err := c.Set("debug", 50*time.Millisecond); err != nil {
		t.Fatalf("Set(debug): %v", err)
	}
	c.Close()
	time.Sleep(80 * time.Millisecond)
	if lv.Level() != slog.LevelDebug {
		t.Fatalf("level = %v after Close, want the set value to stand (no revert)", lv.Level())
	}
}
