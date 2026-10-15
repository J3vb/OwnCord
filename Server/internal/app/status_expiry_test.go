package app

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

type idleExpiryStore struct{}

func (idleExpiryStore) NextCustomStatusExpiry(context.Context) (string, bool, error) {
	return "", false, nil
}

func (idleExpiryStore) ListExpiredCustomStatuses(context.Context, string, int) ([]db.ExpiredCustomStatus, error) {
	return nil, nil
}

func (idleExpiryStore) ClearCustomStatusIfExpiry(context.Context, int64, string) (bool, error) {
	return false, nil
}

// The close step cancels the loop and joins it; a parent that is already gone
// (the event-persistence step cancelling bgCtx first) must not hang it.
func TestRunStatusExpirer_CloseStepJoinsTheLoop(t *testing.T) {
	for _, parentCancelled := range []bool{false, true} {
		parent, cancelParent := context.WithCancel(context.Background())
		stop := runStatusExpirer(parent, service.NewCustomStatusExpirer(idleExpiryStore{}))
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
