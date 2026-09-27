package service

import (
	"testing"
	"time"
)

// SRE-08: a process that was killed or crashed leaves a boot marker behind,
// and the attention panel says so — naming when the previous run started and
// the last panic it recovered.
func TestAttention_UncleanExitWarns(t *testing.T) {
	f := newAttentionFixture(t)
	started := f.now.Add(-2 * time.Hour)
	panicked := f.now.Add(-90 * time.Minute)
	f.s.RecordBootStatus(BootStatus{
		Recorded:    true,
		Unclean:     true,
		StartedAt:   started,
		LastPanicAt: panicked,
	})
	rep := f.step()
	wantStatus(t, rep, "last_exit", AttentionStatusWarning)
	w := warning(rep, "last_exit")
	if w == nil {
		t.Fatal("an unclean exit raised no warning")
	}
	if w.Title == "" || w.Action == "" || w.Detail == "" {
		t.Fatalf("warning = %+v, want a title, an action and a detail", w)
	}
}

// A clean previous shutdown is ok and raises nothing; the first start on a
// service that never read a marker is unknown, never a false warning.
func TestAttention_BootStatusCleanAndUnknown(t *testing.T) {
	f := newAttentionFixture(t)
	wantStatus(t, f.step(), "last_exit", AttentionStatusUnknown)

	f.s.RecordBootStatus(BootStatus{Recorded: true, Unclean: false})
	rep := f.step()
	wantStatus(t, rep, "last_exit", AttentionStatusOK)
	if w := warning(rep, "last_exit"); w != nil {
		t.Fatalf("a clean shutdown raised a warning: %+v", w)
	}
}

// The warning recovers on a later clean restart.
func TestAttention_UncleanExitRecovers(t *testing.T) {
	f := newAttentionFixture(t)
	f.s.RecordBootStatus(BootStatus{Recorded: true, Unclean: true, StartedAt: f.now.Add(-time.Hour)})
	rep := f.step()
	if w := warning(rep, "last_exit"); w == nil {
		t.Fatal("unclean exit raised no warning")
	}
	f.s.RecordBootStatus(BootStatus{Recorded: true, Unclean: false})
	rep = f.step()
	if w := warning(rep, "last_exit"); w == nil || w.RecoveredAt == nil {
		t.Fatalf("warning did not recover after a clean restart: %+v", w)
	}
}
