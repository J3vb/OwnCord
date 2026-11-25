package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// Warnings and timeouts each have a per-moderator budget; an action refused by
// the rank check does not spend it. Users from newTestRoleService: 2 admin
// (ADMINISTRATOR), 4 and 5 members, 1 owner.
func TestWarnAndTimeout_PerModeratorBudget(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	svc, _ := newTestRoleService(t)
	svc.limiter = auth.NewRateLimiter()

	// Refused by rank (the owner outranks admin): no slot spent.
	for range modActionRateLimit + 2 {
		if _, err := svc.Warn(ctx, 2, 1, "reason", nil); !errors.Is(err, ErrForbidden) {
			t.Fatalf("warn the owner: err = %v, want ErrForbidden", err)
		}
	}
	for i := range modActionRateLimit {
		if _, err := svc.Warn(ctx, 2, 5, "reason", nil); err != nil {
			t.Fatalf("warn %d: %v", i, err)
		}
	}
	if _, err := svc.Warn(ctx, 2, 4, "reason", nil); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("warn over budget: err = %v, want ErrRateLimited", err)
	}

	// Timeouts have their own budget.
	for i := range modActionRateLimit {
		if _, err := svc.Timeout(ctx, 2, 5, "reason", 10*time.Minute, nil); err != nil {
			t.Fatalf("timeout %d: %v", i, err)
		}
	}
	if _, err := svc.Timeout(ctx, 2, 4, "reason", 10*time.Minute, nil); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("timeout over budget: err = %v, want ErrRateLimited", err)
	}
}
