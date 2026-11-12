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

	dms, err := database.ListDMChannelIDsAmong(ctx, []int64{guild, oneToOne.ID, group.ID, 9999})
	mustDo(t, "ListDMChannelIDsAmong", err)
	seen := map[int64]bool{}
	for _, id := range dms {
		seen[id] = true
	}
	if len(seen) != 2 || !seen[oneToOne.ID] || !seen[group.ID] {
		t.Errorf("ListDMChannelIDsAmong = %v, want the 1:1 %d and the group %d only", dms, oneToOne.ID, group.ID)
	}

	names, err := database.ListDMChannelNamesAmong(ctx, []int64{guild, oneToOne.ID, group.ID})
	mustDo(t, "ListDMChannelNamesAmong", err)
	if len(names) != 2 || names[group.ID] != "crew" {
		t.Errorf("ListDMChannelNamesAmong = %v, want the two DMs with the group named crew", names)
	}
}
