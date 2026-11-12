package service

import (
	"context"
	"math/rand/v2"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// A message that names only users resolves just those users, and the readers it
// keeps are exactly the full reader walk's readers among them, across random
// roles, role overrides, per-user allow/deny overrides, administrators and bans.
func TestMentionReadersAmong_MatchesFullWalkFilteredToNamedUsers(t *testing.T) {
	const users = 14
	roleIDs := []int64{301, 302, 303, 304}
	for seed := uint64(1); seed <= 25; seed++ {
		rng := rand.New(rand.NewPCG(seed, 11))
		database := newTestDB(t)
		ctx := context.Background()
		const chID = 10
		seedChannel(t, database, &db.Channel{ID: chID, Name: "general", Type: "text"})

		for i, rid := range roleIDs {
			var perms int64
			switch rng.IntN(4) {
			case 0:
				perms = permissions.ReadMessages | permissions.SendMessages
			case 1:
				perms = permissions.SendMessages
			case 2:
				perms = permissions.Administrator
			default:
				perms = permissions.ReadMessages
			}
			seedRole(t, database, &db.Role{ID: rid, Name: "r" + string(rune('a'+i)), Permissions: perms, Position: 10 + i})
			switch rng.IntN(3) {
			case 0:
				seedChannelOverride(t, database, rid, chID, 0, permissions.ReadMessages)
			case 1:
				seedChannelOverride(t, database, rid, chID, permissions.ReadMessages, 0)
			}
		}
		for uid := int64(100); uid < 100+users; uid++ {
			seedUser(t, database, &db.User{ID: uid, Banned: rng.IntN(6) == 0})
			seedUserRole(t, database, uid, roleIDs[rng.IntN(len(roleIDs))])
			if rng.IntN(2) == 0 {
				if _, err := database.ExecContext(ctx,
					`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`,
					uid, roleIDs[rng.IntN(len(roleIDs))]); err != nil {
					t.Fatalf("extra role: %v", err)
				}
			}
			switch rng.IntN(5) {
			case 0:
				mustDo(t, "user allow", database.UpsertChannelUserOverride(ctx, chID, uid, permissions.ReadMessages, 0))
			case 1:
				mustDo(t, "user deny", database.UpsertChannelUserOverride(ctx, chID, uid, 0, permissions.ReadMessages))
			}
		}
		svc := NewMessageService(database, NewPermissionService(database, permissions.NewChecker(database)), nil)

		full, err := svc.mentionReaders(ctx, chID, false, nil)
		if err != nil {
			t.Fatalf("seed %d: mentionReaders: %v", seed, err)
		}
		fullSet := make(map[int64]bool, len(full))
		for _, r := range full {
			fullSet[r.UserID] = true
		}
		for range 6 {
			var named []int64
			for uid := int64(100); uid < 100+users+2; uid++ { // two ids with no user row
				if rng.IntN(3) == 0 {
					named = append(named, uid)
				}
			}
			if len(named) > 0 {
				named = append(named, named[0]) // a repeated id is read once
			}
			got, err := svc.mentionReadersAmong(ctx, chID, named)
			if err != nil {
				t.Fatalf("seed %d: mentionReadersAmong: %v", seed, err)
			}
			gotIDs := make([]int64, 0, len(got))
			var wantIDs []int64
			for _, r := range got {
				gotIDs = append(gotIDs, r.UserID)
			}
			for _, uid := range named {
				if fullSet[uid] && !slices.Contains(wantIDs, uid) {
					wantIDs = append(wantIDs, uid)
				}
			}
			slices.Sort(gotIDs)
			slices.Sort(wantIDs)
			if !slices.Equal(gotIDs, wantIDs) {
				t.Fatalf("seed %d, named %v: direct readers = %v, full walk among them = %v", seed, named, gotIDs, wantIDs)
			}
		}
	}
}

// countingMentionStore counts the full reader walk's member query.
type countingMentionStore struct {
	*db.DB
	byRoles int
}

func (c *countingMentionStore) ListMentionTargetsByRoles(ctx context.Context, roleIDs []int64) ([]db.MentionTarget, error) {
	c.byRoles++
	return c.DB.ListMentionTargetsByRoles(ctx, roleIDs)
}

// A plain @user mention raises the badge without walking every member that holds
// a reading role; @everyone still walks them.
func TestMentionEntries_DirectMentionSkipsMemberWalk(t *testing.T) {
	_, _, database := newMentionFixture(t)
	st := &countingMentionStore{DB: database}
	m := newMentionState(st, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	direct := mentionSet{UserIDs: []int64{2, 3}, RoleIDs: []int64{}}
	entries := m.mentionEntries(ctx, 10, 500, 1, direct, false, nil)
	if st.byRoles != 0 {
		t.Fatalf("direct mention walked the members %d times, want 0", st.byRoles)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	got := slices.Clone(entries[0].UserIDs)
	slices.Sort(got)
	if !slices.Equal(got, []int64{2, 3}) {
		t.Fatalf("recipients = %v, want [2 3]", got)
	}

	everyone := mentionSet{UserIDs: []int64{}, RoleIDs: []int64{}, Everyone: true}
	if entries := m.mentionEntries(ctx, 10, 501, 1, everyone, false, nil); len(entries) != 1 {
		t.Fatalf("@everyone entries = %+v, want one", entries)
	}
	if st.byRoles != 1 {
		t.Fatalf("@everyone walked the members %d times, want 1", st.byRoles)
	}
}

// BenchmarkDirectMentionReaders compares reading the readers for a one-user
// mention on a 1,000-member server: "full-walk" lists every reader, "named"
// reads only the named user.
func BenchmarkDirectMentionReaders(b *testing.B) {
	database := newTestDB(b)
	ctx := context.Background()
	seedChannel(b, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedRole(b, database, &db.Role{ID: 301, Name: "reader", Permissions: permissions.ReadMessages | permissions.SendMessages, Position: 10})
	for uid := int64(100); uid < 1100; uid++ {
		if _, err := database.ExecContext(ctx,
			`INSERT INTO users (id, username, password, role_id) VALUES (?, ?, '', 301)`,
			uid, seedUsername(uid)); err != nil {
			b.Fatalf("insert user: %v", err)
		}
	}
	svc := NewMessageService(database, NewPermissionService(database, permissions.NewChecker(database)), nil)
	b.Run("full-walk", func(b *testing.B) {
		for b.Loop() {
			if _, err := svc.mentionReaders(ctx, 10, false, nil); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("named", func(b *testing.B) {
		for b.Loop() {
			if _, err := svc.mentionReadersAmong(ctx, 10, []int64{555}); err != nil {
				b.Fatal(err)
			}
		}
	})
}
