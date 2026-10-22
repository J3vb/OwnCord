package service

import (
	"context"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const helperRoleID = int64(7)

// newTwoRoleFixture builds the mention fixture plus a Helper role (READ, low
// rank) and a channel 10 the Member role cannot read: the private-channel shape
// (READ denied to the default role). Users: bob=2 and carol=3 hold Member only;
// dave=5 holds Member and Helper; mod=4 reads through the Moderator role.
func newTwoRoleFixture(t *testing.T) (*MessageService, *ChannelService, *PermissionService, *db.DB) {
	t.Helper()
	svc, chSvc, database := newMentionFixture(t)
	seedRole(t, database, &db.Role{
		ID: helperRoleID, Name: "helper", Position: 20,
		Permissions: permissions.ReadMessages | permissions.SendMessages,
	})
	seedUser(t, database, &db.User{ID: 5, Username: "dave", Status: "online"})
	seedUserRole(t, database, 5, permissions.MemberRoleID)
	if err := database.AddUserRole(context.Background(), 5, helperRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if err := database.UpsertChannelOverride(context.Background(), 10, permissions.MemberRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	return svc, chSvc, svc.perms, database
}

// A member holding Member (READ denied here), Helper and a higher Lead role
// that cannot read is a reader through Helper alone, counted
// once; a Member-only user is not.
func TestMentionReaders_TwoRoleHolderCounted(t *testing.T) {
	svc, _, _, database := newTwoRoleFixture(t)
	ctx := context.Background()
	// dave's TOP role is one that cannot read the channel, so only a join on
	// user_roles (not the users.role_id mirror) finds him through Helper.
	seedRole(t, database, &db.Role{ID: 9, Name: "lead", Position: 30, Permissions: permissions.SendMessages})
	if err := database.AddUserRole(ctx, 5, 9); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}

	readers, err := svc.mentionReaders(ctx, 10, false, nil)
	if err != nil {
		t.Fatalf("mentionReaders: %v", err)
	}
	ids := make([]int64, 0, len(readers))
	for _, r := range readers {
		ids = append(ids, r.UserID)
	}
	slices.Sort(ids)
	if !slices.Equal(ids, []int64{4, 5}) {
		t.Fatalf("readers = %v, want [4 5]: the Moderator and the Member+Helper holder, once each", ids)
	}

	// @everyone from the moderator badges dave through his Helper role only.
	if _, err := svc.SendMessage(ctx, SendMessageParams{ChannelID: 10, UserID: 4, Username: "mod", RoleName: "moderator", Content: "@everyone hi"}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if got := mentionCount(t, database, 5); got != 1 {
		t.Errorf("two-role holder mention_count = %d, want 1", got)
	}
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("Member-only mention_count = %d, want 0 (READ is denied to that role here)", got)
	}
}

// A per-user READ deny does not drop a member holding ADMINISTRATOR in a role
// that is not their top role.
func TestMentionReaders_AdminInLowerRoleBypassesUserDeny(t *testing.T) {
	svc, _, _, database := newTwoRoleFixture(t)
	ctx := context.Background()
	seedRole(t, database, &db.Role{ID: 8, Name: "warden", Position: 5, Permissions: permissions.Administrator})
	if err := database.AddUserRole(ctx, 5, 8); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if err := database.UpsertChannelUserOverride(ctx, 10, 5, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	readers, err := svc.mentionReaders(ctx, 10, false, nil)
	if err != nil {
		t.Fatalf("mentionReaders: %v", err)
	}
	if !slices.ContainsFunc(readers, func(r db.MentionTarget) bool { return r.UserID == 5 }) {
		t.Fatalf("an Administrator role below the top must bypass the per-user deny, readers = %+v", readers)
	}
}

// A per-user deny on a bit another held role grants wins over that role: the
// member layer applies after the OR of the role layers, through the cached
// PermissionService path.
func TestPermissionService_UserDenyBeatsOtherRoleGrant(t *testing.T) {
	_, _, perms, database := newTwoRoleFixture(t)
	ctx := context.Background()
	seedRole(t, database, &db.Role{ID: 11, Name: "pinner", Position: 15,
		Permissions: permissions.ReadMessages | permissions.ManageMessages})
	if err := database.AddUserRole(ctx, 5, 11); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	perms.InvalidateUser(5)
	if !perms.HasChannelPerm(ctx, 5, 10, permissions.ManageMessages) {
		t.Fatal("precondition: the second role grants ManageMessages")
	}
	if err := database.UpsertChannelUserOverride(ctx, 10, 5, 0, permissions.ManageMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	perms.InvalidateUser(5)
	if perms.HasChannelPerm(ctx, 5, 10, permissions.ManageMessages) {
		t.Error("a per-user deny must beat the bit another held role grants")
	}
	if !perms.HasChannelPerm(ctx, 5, 10, permissions.ReadMessages) {
		t.Error("the deny is for ManageMessages only; reading must still work")
	}
}

// The cached subject composes every held role: the Helper role reads the
// channel the Member role is denied, the verdict matches a Member-only user
// and the held-role summary carries the OR of the masks.
func TestPermissionService_TwoRoleSubject(t *testing.T) {
	_, chSvc, perms, _ := newTwoRoleFixture(t)
	ctx := context.Background()

	if !perms.HasChannelPerm(ctx, 5, 10, permissions.ReadMessages) {
		t.Error("Member+Helper must read the channel Member is denied")
	}
	if perms.HasChannelPerm(ctx, 2, 10, permissions.ReadMessages) {
		t.Error("Member alone must not read it")
	}
	ok, err := perms.HasChannelPermChecked(ctx, 5, 10, permissions.ReadMessages)
	if err != nil || !ok {
		t.Errorf("HasChannelPermChecked(two roles) = %v, %v; want true, nil", ok, err)
	}

	sub, err := perms.Subject(ctx, 5, 10)
	if err != nil {
		t.Fatalf("Subject: %v", err)
	}
	if len(sub.Layers) != 2 {
		t.Fatalf("Subject.Layers = %+v, want one per held role", sub.Layers)
	}

	held, err := perms.GetRoleForUser(ctx, 5)
	if err != nil || held == nil {
		t.Fatalf("GetRoleForUser: %v, %v", held, err)
	}
	if held.Top.ID != helperRoleID {
		t.Errorf("top role = %d, want the Helper role (position 20 beats Member 1)", held.Top.ID)
	}
	if want := permissions.ReadMessages | permissions.SendMessages; held.Perms != want {
		t.Errorf("Perms = %#x, want the OR of the held masks %#x", held.Perms, want)
	}
	if len(held.IDs) != 2 {
		t.Errorf("IDs = %v, want both held roles", held.IDs)
	}

	// The visible-channel list agrees (REST and ws use the same predicate).
	vis, err := chSvc.ListVisibleChannels(ctx, 5)
	if err != nil || len(vis) != 1 || vis[0].ID != 10 {
		t.Errorf("ListVisibleChannels(two roles) = %+v, %v; want channel 10", vis, err)
	}
	vis, err = chSvc.ListVisibleChannels(ctx, 2)
	if err != nil || len(vis) != 0 {
		t.Errorf("ListVisibleChannels(Member only) = %+v, %v; want none", vis, err)
	}
}

// A cache load racing a role add is discarded by the generation guard, and the
// next read sees both roles.
func TestPermissionService_LoadRacingRoleAddIsDiscarded(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	seedRole(t, database, &db.Role{ID: permissions.MemberRoleID, Name: "member", Position: 1,
		Permissions: permissions.SendMessages | permissions.ReadMessages})
	seedRole(t, database, &db.Role{ID: helperRoleID, Name: "helper", Position: 20, Permissions: permissions.ReadMessages})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "private", Type: "text"})
	if err := database.UpsertChannelOverride(ctx, 10, permissions.MemberRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	store := &raceHookStore{DB: database}
	svc := NewPermissionService(store, permissions.NewChecker(database))
	fired := false
	store.onGetRole = func() {
		if fired {
			return
		}
		fired = true
		// The admin adds the Helper role and invalidates, landing between the
		// populate's role read and its cache store.
		if err := database.AddUserRole(ctx, 1, helperRoleID); err != nil {
			t.Errorf("AddUserRole: %v", err)
		}
		svc.InvalidateUser(1)
	}

	// This populate began on the one-role state; its snapshot must not be cached.
	svc.HasChannelPerm(ctx, 1, 10, permissions.ReadMessages)
	svc.mu.RLock()
	_, cached := svc.cache[1]
	svc.mu.RUnlock()
	if cached {
		t.Fatal("a load that raced a role add was cached; the generation guard must discard it")
	}

	if !svc.HasChannelPerm(ctx, 1, 10, permissions.ReadMessages) {
		t.Fatal("the next read must see both roles and read the channel through Helper")
	}
	held, err := svc.GetRoleForUser(ctx, 1)
	if err != nil || held == nil || len(held.IDs) != 2 {
		t.Fatalf("GetRoleForUser after the add = %+v, %v; want both roles", held, err)
	}
}
