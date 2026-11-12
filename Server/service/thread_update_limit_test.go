package service

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestThreadUpdate_RateLimitedPerUser(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "t")
	for i := range threadUpdateLimit {
		name := string(rune('a' + i))
		if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Name: &name}); err != nil {
			t.Fatalf("update %d: %v", i, err)
		}
	}
	name := "over"
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Name: &name}); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
	// The budget is per user: the moderator is unaffected.
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrMod, ThreadID: th.ID, Name: &name}); err != nil {
		t.Fatalf("moderator update: %v", err)
	}
}

// Two sockets of one user reach the service concurrently and still share one budget.
func TestThreadUpdate_ConcurrentCallersShareBudget(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "t")
	var ok, limited atomic.Int32
	var wg sync.WaitGroup
	for i := range 2 * threadUpdateLimit {
		wg.Go(func() {
			name := string(rune('a' + i))
			_, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Name: &name})
			switch {
			case err == nil:
				ok.Add(1)
			case errors.Is(err, ErrRateLimited):
				limited.Add(1)
			default:
				t.Errorf("update: %v", err)
			}
		})
	}
	wg.Wait()
	if ok.Load() != threadUpdateLimit || limited.Load() != threadUpdateLimit {
		t.Fatalf("ok=%d limited=%d, want %d each", ok.Load(), limited.Load(), threadUpdateLimit)
	}
}

type countingThreadStore struct {
	ThreadStore
	updates atomic.Int32
}

func (c *countingThreadStore) UpdateThread(ctx context.Context, id int64, patch db.ThreadPatch, byMod bool) (*db.ThreadInfo, error) {
	c.updates.Add(1)
	return c.ThreadStore.UpdateThread(ctx, id, patch, byMod)
}

func TestThreadUpdate_NoopWritesNothing(t *testing.T) {
	f := newThreadFixture(t)
	counter := &countingThreadStore{ThreadStore: f.threads.ts}
	f.threads.ts = counter
	th := f.start(t, thrOwner, "t")
	same := th.Name
	archived := false
	minutes := th.AutoArchiveMinutes
	_, changed, err := f.threads.UpdateChanged(bg(), UpdateThreadParams{
		UserID: thrOwner, ThreadID: th.ID, Name: &same, Archived: &archived, AutoArchiveMinutes: &minutes,
	})
	if err != nil || changed {
		t.Fatalf("no-op: changed=%v err=%v", changed, err)
	}
	if n := counter.updates.Load(); n != 0 {
		t.Fatalf("UpdateThread called %d times for a no-op", n)
	}
}

// A patch repeating current values next to one real change still writes.
func TestThreadUpdate_PartialChangeStillWrites(t *testing.T) {
	f := newThreadFixture(t)
	counter := &countingThreadStore{ThreadStore: f.threads.ts}
	f.threads.ts = counter
	th := f.start(t, thrOwner, "t")
	same := th.Name
	archived := true
	out, changed, err := f.threads.UpdateChanged(bg(), UpdateThreadParams{
		UserID: thrOwner, ThreadID: th.ID, Name: &same, Archived: &archived,
	})
	if err != nil || !changed || !out.Archived {
		t.Fatalf("changed=%v out=%+v err=%v", changed, out, err)
	}
	if n := counter.updates.Load(); n != 1 {
		t.Fatalf("UpdateThread calls = %d, want 1", n)
	}
	got, err := f.threads.Get(bg(), th.ID)
	if err != nil || got == nil || !got.Archived {
		t.Fatalf("stored = %+v, %v", got, err)
	}
}
