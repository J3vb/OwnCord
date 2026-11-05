package service

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// A shortened idle period can make a thread due before the planned wake-up;
// Wake makes Run re-read the due time and archive it now, not at the cap.
func TestThreadArchiver_WakeRereadsTheDueTime(t *testing.T) {
	st := &recordingStore{dueOK: true, due: time.Now().Add(time.Hour), batches: [][]db.DueThread{{{ID: 7, ParentID: 1}}}, listed: []int{1}}
	a := fastArchiver(st)
	a.maxSleep = time.Hour
	a.wake = make(chan struct{}, 1)
	rec := &threadRecorder{}
	a.SetNotifier(rec)
	ctx, cancel := context.WithCancel(bg())
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	time.Sleep(30 * time.Millisecond)
	if st.sweeps() != 0 {
		t.Fatalf("%d sweeps before anything fell due", st.sweeps())
	}
	st.mu.Lock()
	st.due = time.Now().Add(-time.Second)
	st.mu.Unlock()
	a.Wake()
	a.Wake() // a second wake while one is pending never blocks

	deadline := time.Now().Add(5 * time.Second)
	for len(rec.got()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := rec.got(); len(got) == 0 || got[0] != 7 {
		t.Fatalf("notified %v, want thread 7 archived right after the wake", got)
	}
}

func TestThreadService_UpdateWakesTheArchiverOnlyForAPeriodChange(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "wake")
	wakes := 0
	f.threads.SetArchiveWake(func() { wakes++ })

	name := "renamed"
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Name: &name}); err != nil {
		t.Fatal(err)
	}
	if wakes != 0 {
		t.Fatalf("a rename woke the archiver %d times", wakes)
	}
	period := 60
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, AutoArchiveMinutes: &period}); err != nil {
		t.Fatal(err)
	}
	if wakes != 1 {
		t.Fatalf("a period change woke the archiver %d times, want 1", wakes)
	}
	// A refused change commits nothing and wakes nothing.
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOther, ThreadID: th.ID, AutoArchiveMinutes: &period}); err == nil {
		t.Fatal("a non-owner changed the period")
	}
	if wakes != 1 {
		t.Fatalf("a refused change woke the archiver (%d wakes)", wakes)
	}
}
