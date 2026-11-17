package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// A caller cancelled right after the commit still gets the channel it created.
func TestCreateGroupDMChannel_CancelAfterCommitReturnsChannel(t *testing.T) {
	database := groupDMFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	db.SetGroupDMPostCommitHookForTest(cancel)
	t.Cleanup(func() { db.SetGroupDMPostCommitHookForTest(nil) })

	ch, err := database.CreateGroupDMChannel(ctx, "Crew", 1, []int64{1, 2, 3})
	if err != nil || ch == nil {
		t.Fatalf("CreateGroupDMChannel after commit-time cancel = %v, %v; want the channel", ch, err)
	}
	dms, err := database.GetUserDMChannels(context.Background(), 2)
	if err != nil || len(dms) != 1 || dms[0].ChannelID != ch.ID {
		t.Fatalf("committed group missing for member: %v, %v", dms, err)
	}
}
