package service

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

func TestTimeoutSnapshot_FiltersExpiredAndCopies(t *testing.T) {
	s := NewPermissionService(newTestDB(t), permissions.NewChecker(newTestDB(t)))
	if m, ok := s.TimeoutSnapshot(); ok || m != nil {
		t.Fatalf("unloaded mirror: snapshot = %v, %v; want nil, false", m, ok)
	}
	now := time.Now()
	mirror := map[int64]time.Time{1: now.Add(time.Hour), 2: now.Add(-time.Minute)}
	s.timeouts.Store(&mirror)

	snap, ok := s.TimeoutSnapshot()
	if !ok || len(snap) != 1 {
		t.Fatalf("snapshot = %v, %v; want only the unexpired entry", snap, ok)
	}
	if _, has := snap[1]; !has {
		t.Fatalf("snapshot = %v, want user 1", snap)
	}
	snap[7] = now // mutating the copy must not touch the mirror
	delete(snap, 1)
	again, _ := s.TimeoutSnapshot()
	if len(again) != 1 || len(mirror) != 2 {
		t.Fatalf("mirror changed through the copy: snapshot %v, mirror %v", again, mirror)
	}
}

func TestActiveTimeouts_ReloadsFromStore(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	s := NewPermissionService(database, permissions.NewChecker(database))
	if err := s.RefreshTimeouts(ctx); err != nil {
		t.Fatalf("RefreshTimeouts: %v", err)
	}
	actor, err := database.CreateUser(ctx, "at-actor", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	target, err := database.CreateUser(ctx, "at-target", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// Written behind the mirror's back: ActiveTimeouts must still see it.
	if _, _, err := database.TimeoutUser(ctx, target, actor, nil, "x", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	got, err := s.ActiveTimeouts(ctx)
	if err != nil {
		t.Fatalf("ActiveTimeouts: %v", err)
	}
	if _, ok := got[target]; !ok || len(got) != 1 {
		t.Fatalf("ActiveTimeouts = %v, want the target", got)
	}
}
