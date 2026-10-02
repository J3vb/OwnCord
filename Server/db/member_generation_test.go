package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// Migration 057's triggers are the ready path's only invalidation signal for
// the shared member list (ws/serve_ready_members_cache.go), so every write
// that can change ListMembers must move the generation, and a status stamp,
// which every connect makes, must not.
func TestMemberGeneration_MovesOnMemberWritesOnly(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	gen := func() int64 {
		t.Helper()
		g, err := database.MemberGeneration(ctx)
		if err != nil {
			t.Fatalf("MemberGeneration: %v", err)
		}
		return g
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	str := func(s string) *string { return &s }

	uid, err := database.CreateUser(ctx, "alice", "hash", 4)
	must(err)
	expires := time.Now().Add(time.Hour)
	var pending int64

	steps := []struct {
		name  string
		write func()
		moves bool
	}{
		{"join", func() { _, err := database.CreateUser(ctx, "bob", "hash", 4); must(err) }, true},
		{"connect stamp", func() { must(database.UpdateUserStatus(ctx, uid, db.StatusOnline)) }, false},
		{"disconnect stamp", func() { must(database.StampConnections(ctx, nil, []int64{uid})) }, false},
		{"ban", func() { must(database.BanUser(ctx, uid, "r", &expires)) }, true},
		{"unban", func() { must(database.UnbanUser(ctx, uid)) }, true},
		{"role change", func() { must(database.UpdateUserRole(ctx, uid, 3)) }, true},
		{"profile", func() { must(database.UpdateUserProfile(ctx, uid, "alice", nil, str("Al"), nil)) }, true},
		{"profile rewrite, nothing changed", func() { must(database.UpdateUserProfile(ctx, uid, "alice", nil, str("Al"), nil)) }, false},
		{"custom status", func() { must(database.UpdateUserCustomStatus(ctx, uid, str("busy"))) }, true},
		{"identity key", func() { must(database.UpdateUserIdentityKey(ctx, uid, str("k"))) }, true},
		{"role rename", func() {
			r, err := database.GetRoleByID(ctx, 4)
			must(err)
			must(database.UpdateRole(ctx, r.ID, "Regulars", r.Color, r.Permissions, r.Position))
		}, true},
		{"registration request", func() {
			pending, err = database.CreatePendingUser(ctx, "carol", "hash", 4, 10)
			must(err)
		}, true},
		{"registration approval", func() { must(database.ApprovePendingUser(ctx, pending)) }, true},
	}
	for _, s := range steps {
		before := gen()
		s.write()
		if moved := gen() != before; moved != s.moves {
			t.Errorf("%s: generation moved = %v, want %v", s.name, moved, s.moves)
		}
	}
}

func TestNextMemberBanLapse(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	lapse := func() string {
		t.Helper()
		at, err := database.NextMemberBanLapse(ctx)
		if err != nil {
			t.Fatalf("NextMemberBanLapse: %v", err)
		}
		return at
	}
	if got := lapse(); got != "" {
		t.Fatalf("no bans: lapse = %q, want empty", got)
	}
	a, _ := database.CreateUser(ctx, "a", "hash", 4)
	b, _ := database.CreateUser(ctx, "b", "hash", 4)
	c, _ := database.CreateUser(ctx, "c", "hash", 4)
	soon := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	later := soon.Add(time.Hour)
	past := time.Now().UTC().Add(-time.Hour)
	_ = database.BanUser(ctx, a, "r", &later)
	_ = database.BanUser(ctx, b, "r", &soon)
	_ = database.BanUser(ctx, c, "r", &past) // already lapsed: ListMembers shows c
	if got, want := lapse(), soon.Format("2006-01-02T15:04:05Z"); got != want {
		t.Errorf("lapse = %q, want the earliest pending one %q", got, want)
	}
}
