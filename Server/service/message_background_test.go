package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// blockingMentionStore is the real DB with the no-worker mention write held
// until its ctx ends, reporting how it ended — a wedged DB, as far as bg's
// goroutine can tell.
type blockingMentionStore struct {
	*db.DB
	ended chan error
}

func (s *blockingMentionStore) IncrementMentionCountsBatch(ctx context.Context, _ int64, _ []db.MentionBatchEntry) (map[int64]int64, error) {
	<-ctx.Done()
	s.ended <- ctx.Err()
	return nil, ctx.Err()
}

// blockingPushNotifier is a push notifier that never answers until its ctx ends.
type blockingPushNotifier struct{ ended chan error }

func (n *blockingPushNotifier) Notify(ctx context.Context, _, _ int64, _ []int64) {
	<-ctx.Done()
	n.ended <- ctx.Err()
}

// SendMessage's background jobs outlive the request, so their ctx is detached
// from it. Against a wedged store and push service each must still give up at
// its deadline rather than hold a goroutine per message forever.
func TestSendMessage_BackgroundJobsAreBounded(t *testing.T) {
	old := backgroundJobTimeout
	backgroundJobTimeout = 20 * time.Millisecond
	t.Cleanup(func() { backgroundJobTimeout = old })

	_, _, database := newMentionFixture(t)
	ended := make(chan error, 2)
	svc := NewMessageService(&blockingMentionStore{DB: database, ended: ended},
		NewPermissionService(database, permissions.NewChecker(database)), nil)
	svc.SetPushNotifier(&blockingPushNotifier{ended: ended})

	sendAs(t, svc, 1, "hi @Bob")

	for i := range 2 {
		select {
		case err := <-ended:
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Errorf("background job ended with %v, want context.DeadlineExceeded", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("background job %d of 2 never ended: its ctx has no deadline", i+1)
		}
	}
}

// A push dispatch runs on the group the composition root installs, so the
// shutdown's Stop reaches it: past the grace the group cancels Notify's ctx
// and Stop returns once Notify has (ARCH-034).
func TestSendMessage_PushRunsOnInstalledGroup(t *testing.T) {
	_, _, database := newMentionFixture(t)
	svc := NewMessageService(database,
		NewPermissionService(database, permissions.NewChecker(database)), nil)
	notifier := &blockingPushNotifier{ended: make(chan error, 1)}
	svc.SetPushNotifier(notifier)
	group := syncutil.NewGroup(context.Background())
	svc.SetBackground(group)

	sendAs(t, svc, 1, "hello")

	if n := group.Stop(context.Background(), 20*time.Millisecond); n != 0 {
		t.Fatalf("Stop stragglers = %d, want 0 (Notify honours its ctx)", n)
	}
	select {
	case err := <-notifier.ended:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("Notify ended with %v, want context.Canceled from the group's Stop", err)
		}
	default:
		t.Fatal("Stop returned before Notify finished: the push is not joined")
	}

	// After the drain a send spawns nothing and does not fail.
	sendAs(t, svc, 1, "after the drain")
	select {
	case err := <-notifier.ended:
		t.Errorf("a push ran after the drain began: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
}
