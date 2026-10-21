package service

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// gateStore counts the permission-load reads and can hold the first
// GetMemberRoles call open until released, so a test controls exactly which
// callers are in flight while a load runs.
type gateStore struct {
	*db.DB
	roleCalls     atomic.Int64
	overrideCalls atomic.Int64
	roleByIDCalls atomic.Int64
	// gate, when non-nil, blocks GetMemberRoles (after counting it) and, when
	// set, signals on entered once.
	gate    chan struct{}
	entered chan struct{}
	once    sync.Once
}

func (g *gateStore) GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error) {
	g.roleCalls.Add(1)
	role, err := g.DB.GetMemberRoles(ctx, userID)
	if g.entered != nil {
		g.once.Do(func() { close(g.entered) })
	}
	if g.gate != nil {
		select {
		case <-g.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return role, err
}

func (g *gateStore) GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error) {
	g.overrideCalls.Add(1)
	return g.DB.GetMemberGrants(ctx, userID)
}

func (g *gateStore) GetRoleByID(ctx context.Context, id int64) (*db.Role, error) {
	g.roleByIDCalls.Add(1)
	return g.DB.GetRoleByID(ctx, id)
}

func newGateService(t *testing.T, gated bool) (*PermissionService, *gateStore) {
	t.Helper()
	database := newTestDB(t)
	color := "#112233"
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Color:       &color,
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	g := &gateStore{DB: database}
	if gated {
		g.gate = make(chan struct{})
		g.entered = make(chan struct{})
	}
	return NewPermissionService(g, permissions.NewChecker(database)), g
}

// waitMisses blocks until the service has counted n cache misses, i.e. n
// callers are past the cache check and inside (or waiting on) a load.
func waitMisses(t *testing.T, svc *PermissionService, n uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, m := svc.CacheStats(); m >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d misses", n)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPermissionColdCacheCoalescesLoads(t *testing.T) {
	svc, g := newGateService(t, true)
	const n = 50
	var wg sync.WaitGroup
	var denied atomic.Int64
	for i := range n {
		wg.Go(func() {
			if i%2 == 0 {
				if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
					denied.Add(1)
				}
				return
			}
			sub, err := svc.Subject(context.Background(), 1, 10)
			if err != nil || sub.RolePerms&permissions.SendMessages == 0 {
				denied.Add(1)
			}
		})
	}
	<-g.entered
	waitMisses(t, svc, n)
	close(g.gate)
	wg.Wait()
	if denied.Load() != 0 {
		t.Fatalf("%d callers got a wrong answer", denied.Load())
	}
	if got := g.roleCalls.Load(); got != 1 {
		t.Fatalf("GetMemberRoles calls = %d, want 1", got)
	}
	if got := g.overrideCalls.Load(); got != 1 {
		t.Fatalf("GetMemberGrants calls = %d, want 1", got)
	}
}

func TestPermissionInvalidationDuringLoadIsNotShared(t *testing.T) {
	svc, g := newGateService(t, true)

	first := make(chan bool, 1)
	go func() {
		first <- svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages)
	}()
	<-g.entered
	waitMisses(t, svc, 1)

	svc.InvalidateAll()

	// A caller arriving after the invalidation must start its own load.
	second := make(chan bool, 1)
	go func() {
		second <- svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages)
	}()
	waitMisses(t, svc, 2)
	close(g.gate)

	if !<-first || !<-second {
		t.Fatal("both callers should see the member's SendMessages bit")
	}
	if got := g.roleCalls.Load(); got != 2 {
		t.Fatalf("GetMemberRoles calls = %d, want 2 (post-invalidation caller must not share the stale load)", got)
	}

	// The pre-invalidation load must not have been cached; the second one is.
	svc.mu.RLock()
	cp := svc.cache[1]
	svc.mu.RUnlock()
	if cp == nil {
		t.Fatal("post-invalidation load should be cached")
	}
	before := g.roleCalls.Load()
	svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages)
	if g.roleCalls.Load() != before {
		t.Fatal("warm cache should serve without a store read")
	}
}

func TestPermissionStaleLoadNotCached(t *testing.T) {
	svc, g := newGateService(t, true)
	done := make(chan struct{})
	go func() {
		defer close(done)
		svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages)
	}()
	<-g.entered
	svc.InvalidateUser(1)
	close(g.gate)
	<-done
	svc.mu.RLock()
	_, cached := svc.cache[1]
	svc.mu.RUnlock()
	if cached {
		t.Fatal("a load that raced an invalidation must not be cached")
	}
}

func TestPermissionCancelledWaiterDoesNotFailOthers(t *testing.T) {
	svc, g := newGateService(t, true)

	// The leader owns the shared load; it is the one that gets cancelled, to
	// prove the load itself is detached from its context.
	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderErr := make(chan error, 1)
	go func() {
		_, err := svc.HasChannelPermChecked(leaderCtx, 1, 10, permissions.SendMessages)
		leaderErr <- err
	}()
	<-g.entered

	type result struct {
		ok  bool
		err error
	}
	others := make(chan result, 3)
	for range 3 {
		go func() {
			ok, err := svc.HasChannelPermChecked(context.Background(), 1, 10, permissions.SendMessages)
			others <- result{ok, err}
		}()
	}
	waitMisses(t, svc, 4)

	cancelLeader()
	select {
	case err := <-leaderErr:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled caller err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled caller did not return promptly")
	}

	close(g.gate)
	for range 3 {
		r := <-others
		if r.err != nil || !r.ok {
			t.Fatalf("surviving waiter got ok=%v err=%v", r.ok, r.err)
		}
	}
	if got := g.roleCalls.Load(); got != 1 {
		t.Fatalf("GetMemberRoles calls = %d, want 1", got)
	}
}

func TestGetRoleForUserWarmCacheNoStoreRead(t *testing.T) {
	svc, g := newGateService(t, false)
	ctx := context.Background()
	if !svc.HasChannelPerm(ctx, 1, 10, permissions.SendMessages) {
		t.Fatal("warm-up denied")
	}
	reads := g.roleCalls.Load()

	r1, err := svc.GetRoleForUser(ctx, 1)
	if err != nil || r1 == nil {
		t.Fatalf("GetRoleForUser: %v, %v", r1, err)
	}
	if r1.Top.ID != permissions.MemberRoleID || r1.Top.Name != "member" || r1.Top.Color == nil || *r1.Top.Color != "#112233" {
		t.Fatalf("unexpected role %+v", r1)
	}
	if r1.Perms != permissions.SendMessages|permissions.ReadMessages || len(r1.IDs) != 1 || r1.IDs[0] != permissions.MemberRoleID {
		t.Fatalf("unexpected held-role summary %+v", r1)
	}
	if g.roleCalls.Load() != reads || g.roleByIDCalls.Load() != 0 {
		t.Fatal("warm GetRoleForUser must not read the store")
	}

	// Mutating the returned copy must not leak into the cache.
	*r1.Top.Color = "#ffffff"
	r1.Top.Name = "mutated"
	r1.IDs[0] = 999
	r2, err := svc.GetRoleForUser(ctx, 1)
	if err != nil {
		t.Fatalf("GetRoleForUser: %v", err)
	}
	if r2.Top.Name != "member" || *r2.Top.Color != "#112233" || r2.IDs[0] != permissions.MemberRoleID {
		t.Fatalf("cached role was aliased: %+v", r2)
	}
	if r1.Top.Color == r2.Top.Color {
		t.Fatal("Color pointer is shared between calls")
	}
}

// panicStore panics inside the shared load.
type panicStore struct{ *gateStore }

func (p *panicStore) GetMemberRoles(context.Context, int64) (*db.MemberRoles, error) {
	panic("store exploded")
}

func TestPermissionLoadPanicBecomesError(t *testing.T) {
	_, g := newGateService(t, false)
	svc := NewPermissionService(&panicStore{g}, permissions.NewChecker(g.DB))
	cp, err := svc.getOrPopulate(context.Background(), 1)
	if err == nil || cp != nil {
		t.Fatalf("getOrPopulate = (%v, %v), want a load error", cp, err)
	}
	if svc.HasChannelPerm(context.Background(), 1, 10, permissions.ReadMessages) {
		t.Fatal("a panicking load must deny")
	}
}
