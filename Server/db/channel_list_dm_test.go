package db_test

import (
	"context"
	"testing"
)

func TestListChannels_LeavesDMRowsOut(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	guild := mustCreateChannel(t, database, "general", "text", "", "", 0)
	alice := seedUser(t, database, "list-dm-a")
	bob := seedUser(t, database, "list-dm-b")
	carol := seedUser(t, database, "list-dm-c")
	oneToOne, _, err := database.GetOrCreateDMChannel(ctx, alice, bob)
	mustDo(t, "GetOrCreateDMChannel", err)
	group, err := database.CreateGroupDMChannel(ctx, "crew", alice, []int64{alice, bob, carol})
	mustDo(t, "CreateGroupDMChannel", err)

	got, err := database.ListChannels(ctx)
	mustDo(t, "ListChannels", err)
	if len(got) != 1 || got[0].ID != guild {
		t.Fatalf("ListChannels = %+v, want only the guild channel %d", got, guild)
	}

	all, err := database.ListAllChannels(ctx)
	mustDo(t, "ListAllChannels", err)
	seen := map[int64]bool{}
	for i := range all {
		seen[all[i].ID] = true
	}
	for _, id := range []int64{guild, oneToOne.ID, group.ID} {
		if !seen[id] {
			t.Errorf("ListAllChannels missing channel %d", id)
		}
	}
}
