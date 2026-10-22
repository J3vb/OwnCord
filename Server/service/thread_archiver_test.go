package service

import (
	"context"
	"sync"
	"testing"
	"time"
)

type threadRecorder struct {
	mu  sync.Mutex
	ids []int64
}

func (r *threadRecorder) ThreadChanged(id int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ids = append(r.ids, id)
}

func (r *threadRecorder) got() []int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]int64(nil), r.ids...)
}

func setActivity(t *testing.T, f *threadFixture, id int64, at time.Time) {
	t.Helper()
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE channels SET thread_last_activity_at = ? WHERE id = ?`, at.UTC().Format("2006-01-02T15:04:05Z"), id); err != nil {
		t.Fatal(err)
	}
}

func TestThreadArchiver_DueNotDueAndBootSweep(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	idle := f.start(t, thrMod, "idle")
	fresh := f.start(t, thrMod, "fresh")
	now := time.Now().UTC()
	setActivity(t, f, idle.ID, now.Add(-2*time.Hour)) // 60-minute window? default is 1440
	setActivity(t, f, fresh.ID, now.Add(-10*time.Minute))
	// The default window is a day: nothing is due yet.
	a := NewThreadArchiver(f.database)
	n := &threadRecorder{}
	a.SetNotifier(n)
	if err := a.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if len(n.got()) != 0 {
		t.Fatalf("archived %v before the window passed", n.got())
	}
	// Shorten the idle thread's window to an hour: it is due, the other is not.
	if _, err := f.database.ExecContext(ctx, `UPDATE channels SET thread_auto_archive_minutes = 60 WHERE id = ?`, idle.ID); err != nil {
		t.Fatal(err)
	}
	if err := a.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if got := n.got(); len(got) != 1 || got[0] != idle.ID {
		t.Fatalf("notified %v, want [%d]", got, idle.ID)
	}
	if th, _ := f.threads.Get(ctx, idle.ID); !th.Archived {
		t.Fatal("idle thread not archived")
	}
	if th, _ := f.threads.Get(ctx, fresh.ID); th.Archived {
		t.Fatal("fresh thread archived")
	}
	// A second sweep has nothing left.
	if err := a.Sweep(ctx); err != nil || len(n.got()) != 1 {
		t.Fatalf("second sweep: err=%v notified=%v", err, n.got())
	}
}

func TestThreadArchiver_NextSleepAndStop(t *testing.T) {
	f := newThreadFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	a := NewThreadArchiver(f.database)
	if s, failed := a.nextSleep(ctx); failed || s != a.maxSleep {
		t.Fatalf("no open thread: sleep=%v failed=%v, want the cap", s, failed)
	}
	th := f.start(t, thrMod, "t")
	setActivity(t, f, th.ID, time.Now().Add(-23*time.Hour-59*time.Minute))
	if s, _ := a.nextSleep(ctx); s > 2*time.Minute {
		t.Fatalf("sleep = %v, want about a minute", s)
	}
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit on cancel")
	}
}
