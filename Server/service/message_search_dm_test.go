package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// in:<name> still finds a group DM the caller is in, by the DM's own name, and
// nobody outside it.
func TestSearchScope_InNameMatchesOwnGroupDM(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	a, err := database.CreateUser(ctx, "srch-a", "hash", 4)
	mustDo(t, "CreateUser a", err)
	b, err := database.CreateUser(ctx, "srch-b", "hash", 4)
	mustDo(t, "CreateUser b", err)
	c, err := database.CreateUser(ctx, "srch-c", "hash", 4)
	mustDo(t, "CreateUser c", err)
	outsider, err := database.CreateUser(ctx, "srch-out", "hash", 4)
	mustDo(t, "CreateUser outsider", err)
	group, err := database.CreateGroupDMChannel(ctx, "crew", a, []int64{a, b, c})
	mustDo(t, "CreateGroupDMChannel", err)
	if _, err := database.CreateMessage(ctx, group.ID, a, "pineapple plans", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	svc := NewMessageService(database, NewPermissionService(database, permissions.NewChecker(database)), nil)

	got, _, err := svc.SearchMessages(ctx, b, SearchRequest{Query: "pineapple in:crew"})
	mustDo(t, "member search", err)
	if len(got) != 1 || got[0].ChannelID != group.ID {
		t.Fatalf("member's in:crew search = %+v, want the one hit in group DM %d", got, group.ID)
	}

	got, _, err = svc.SearchMessages(ctx, outsider, SearchRequest{Query: "pineapple in:crew"})
	mustDo(t, "outsider search", err)
	if len(got) != 0 {
		t.Fatalf("a user outside the DM got %+v", got)
	}
}
