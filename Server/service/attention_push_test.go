package service

import (
	"context"
	"testing"
	"time"
)

// pushWatch counts the owner pushes an AttentionService asks for.
func pushWatch(f *attentionFixture) *int {
	n := new(int)
	f.s.SetCriticalNotifier(func(context.Context) { *n++ })
	return n
}

// A warning that worsens to critical pushes the owner once; staying critical pushes nothing more.
func TestAttentionPush_FiresOnceWhenAWarningTurnsCritical(t *testing.T) {
	f := newAttentionFixture(t)
	n := pushWatch(f)
	f.free = 900 << 20
	f.step()
	f.step()
	if *n != 0 {
		t.Fatalf("pushes = %d at warning, want 0", *n)
	}
	f.free = 200 << 20
	for range 5 {
		f.step()
	}
	if *n != 1 {
		t.Fatalf("pushes = %d, want 1 for a sustained critical", *n)
	}
}

// A signal that flaps critical and healthy at every sample pushes once per 6 h, and again after it.
func TestAttentionPush_FlappingSignalIsThrottledPerSignal(t *testing.T) {
	f := newAttentionFixture(t)
	n := pushWatch(f)
	flap := func(rounds int) {
		for range rounds {
			f.free = 200 << 20
			f.step()
			f.step()
			f.free = 10 << 30
			f.step()
			f.step()
		}
	}
	flap(20) // 80 minutes of flapping, several new occurrences
	if *n != 1 {
		t.Fatalf("pushes = %d after a flapping hour, want 1", *n)
	}
	if occ := warning(f.s.Report(), "disk").Occurrences; occ < 2 {
		t.Fatalf("occurrences = %d, the test must flap through several", occ)
	}
	f.now = f.now.Add(attentionPushEvery)
	flap(1)
	if *n != 2 {
		t.Fatalf("pushes = %d after the throttle passed, want 2", *n)
	}
}

// Another signal turning critical is not held back by the first one's throttle.
func TestAttentionPush_ThrottleIsPerSignal(t *testing.T) {
	f := newAttentionFixture(t)
	n := pushWatch(f)
	f.free = 200 << 20
	f.step()
	f.step()
	f.voice = &VoiceHealth{Managed: true, GaveUp: true}
	f.step()
	f.step()
	if *n != 2 {
		t.Fatalf("pushes = %d, want one for disk and one for voice", *n)
	}
}

// Rate signals are outside the owner push, and no notifier means nothing is sent and nothing breaks.
func TestAttentionPush_NoNotifierAndUnlistedSignalsSendNothing(t *testing.T) {
	f := newAttentionFixture(t)
	f.free = 200 << 20
	f.step()
	f.step() // no notifier installed: must not panic or error
	n := pushWatch(f)
	f.alive = false
	f.drops = 1000
	f.step()
	f.step()
	f.step()
	if *n != 0 {
		t.Fatalf("pushes = %d, want 0: a disk already critical is not new and delivery is not an owner signal", *n)
	}
}

// The throttle lives on the warning, so Evaluate sampled at a fixed clock reads it the same way.
func TestAttentionPush_ThrottleUsesTheSampleClock(t *testing.T) {
	f := newAttentionFixture(t)
	n := pushWatch(f)
	f.free = 200 << 20
	f.step()
	f.step()
	f.now = f.now.Add(attentionPushEvery - 10*time.Minute)
	f.free = 10 << 30
	f.step()
	f.step()
	f.free = 200 << 20
	f.step()
	f.step()
	if *n != 1 {
		t.Fatalf("pushes = %d inside the window, want 1", *n)
	}
}

// RefreshBackup is a path of its own into settle: a backup turning critical there pushes the owner too,
// and the next full sample does not push it again.
func TestAttentionPush_RefreshBackupCrossingCriticalPushes(t *testing.T) {
	f := newAttentionFixture(t)
	n := pushWatch(f)
	f.schedule = "daily"
	f.step()
	f.last = f.now.Add(-4 * 24 * time.Hour)
	f.s.RefreshBackup(context.Background(), f.now)
	if *n != 1 {
		t.Fatalf("pushes = %d after the refresh crossed critical, want 1", *n)
	}
	wantStatus(t, f.s.Report(), "backup", AttentionStatusCritical)
	f.step()
	f.step()
	if *n != 1 {
		t.Fatalf("pushes = %d after the next samples, want still 1", *n)
	}
}
