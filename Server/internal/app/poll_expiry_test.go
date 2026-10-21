package app

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

type idlePollStore struct{}

func (idlePollStore) NextPollExpiry(context.Context) (string, bool, error) { return "", false, nil }

func (idlePollStore) ListDuePolls(context.Context, string, int) ([]db.DuePoll, error) {
	return nil, nil
}

// The close step cancels the loop and joins it; a parent that is already gone
// (the event-persistence step cancelling bgCtx first) must not hang it.
func TestPollExpiryStage_JoinsOnClose(t *testing.T) {
	for _, parentCancelled := range []bool{false, true} {
		parent, cancelParent := context.WithCancel(context.Background())
		stop := runPollExpirer(parent, service.NewPollExpirer(idlePollStore{}, nil))
		if parentCancelled {
			cancelParent()
		}
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := stop(closeCtx); err != nil {
			t.Errorf("parentCancelled=%v: close step = %v, want nil", parentCancelled, err)
		}
		cancel()
		cancelParent()
	}
}

func TestStages_PollExpiryFollowsStatusExpiry(t *testing.T) {
	stages := (&App{}).stages()
	names := make([]string, 0, len(stages))
	for _, s := range stages {
		names = append(names, s.name)
	}
	for i, n := range names {
		if n == "status-expiry" {
			if i+1 >= len(names) || names[i+1] != "poll-expiry" {
				t.Fatalf("stage after status-expiry = %v, want poll-expiry", names[i+1:])
			}
			return
		}
	}
	t.Fatal("no status-expiry stage")
}
