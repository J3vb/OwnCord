package db_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
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
		{"profile", func() { must(database.UpdateUserProfile(ctx, uid, "alice", nil, str("Al"), nil, nil, nil)) }, true},
		{"profile rewrite, nothing changed", func() { must(database.UpdateUserProfile(ctx, uid, "alice", nil, str("Al"), nil, nil, nil)) }, false},
		{"about only", func() { must(database.UpdateUserProfile(ctx, uid, "alice", nil, str("Al"), str("hello"), nil, nil)) }, true},
		{"about rewrite, nothing changed", func() { must(database.UpdateUserProfile(ctx, uid, "alice", nil, str("Al"), str("hello"), nil, nil)) }, false},
		{"custom status", func() { must(database.UpdateUserCustomStatus(ctx, uid, str("busy"))) }, true},
		{"expiry rewrite, same text", func() {
			must(database.UpdateUserPresence(ctx, uid, db.StatusOnline, str("busy"), str("2099-01-01T00:00:00Z")))
		}, false},
		{"custom status expiry clear", func() {
			ok, err := database.ClearCustomStatusIfExpiry(ctx, uid, "2099-01-01T00:00:00Z")
			must(err)
			if !ok {
				t.Fatal("ClearCustomStatusIfExpiry cleared nothing")
			}
		}, true},
		{"identity key", func() { must(database.UpdateUserIdentityKey(ctx, uid, str("k"))) }, true},
		{"role rename", func() {
			r, err := database.GetRoleByID(ctx, 4)
			must(err)
			_, err = database.UpdateRole(ctx, r.ID, "Regulars", r.Color, r.Permissions, r.Position, false, false)
			must(err)
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

// ListMembers renders created_at in the wire layout, and carries about.
func TestListMembers_AboutAndCreatedAtRFC3339(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	about := "hello"
	uid, err := database.CreateUser(ctx, "alice", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.UpdateUserProfile(ctx, uid, "alice", nil, nil, &about, nil, nil); err != nil {
		t.Fatal(err)
	}
	members, err := database.ListMembers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got *db.MemberSummary
	for i := range members {
		if members[i].ID == uid {
			got = &members[i]
		}
	}
	if got == nil {
		t.Fatal("alice missing from ListMembers")
	}
	if got.About == nil || *got.About != about {
		t.Errorf("About = %v, want %q", got.About, about)
	}
	if _, err := time.Parse(dbtime.ISOLayout, got.CreatedAt); err != nil {
		t.Errorf("CreatedAt %q is not %s: %v", got.CreatedAt, dbtime.ISOLayout, err)
	}
	u, err := database.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if want := db.FormatMemberCreatedAt(u.CreatedAt); got.CreatedAt != want {
		t.Errorf("ListMembers created_at %q != FormatMemberCreatedAt(%q) = %q", got.CreatedAt, u.CreatedAt, want)
	}
}

// Migration 061 re-creates the 057 trigger with about watched.
func TestMigration061_TriggerWatchesAbout(t *testing.T) {
	database := openMigratedMemory(t)
	var sql string
	err := database.SQLDb().QueryRowContext(context.Background(),
		`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='member_generation_users_update'`).Scan(&sql)
	if err != nil {
		t.Fatalf("trigger lookup: %v", err)
	}
	if strings.Count(sql, "about") < 2 {
		t.Errorf("trigger must name about in UPDATE OF and WHEN, got:\n%s", sql)
	}
}

func TestFormatMemberCreatedAt(t *testing.T) {
	cases := map[string]string{
		"2026-10-15 13:04:05":       "2026-10-15T13:04:05Z",
		"2026-10-15T13:04:05Z":      "2026-10-15T13:04:05Z",
		"2026-10-15T15:04:05+02:00": "2026-10-15T13:04:05Z",
		"garbage":                   "garbage",
	}
	for in, want := range cases {
		if got := db.FormatMemberCreatedAt(in); got != want {
			t.Errorf("FormatMemberCreatedAt(%q) = %q, want %q", in, got, want)
		}
	}
}
