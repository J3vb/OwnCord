package ws_test

import (
	"context"
	"encoding/json"
	"testing"
)

// ready lists guild channels in channels and every DM, group included, in dm_channels only.
func TestBuildReady_GuildChannelsAndDMsStaySeparate(t *testing.T) {
	hub, database := newCoverageHub(t)
	ctx := context.Background()
	general := mustCreateChannel(t, database, "general", "text")
	member := seedTestUser(t, database, "split-member")
	peer := seedTestUser(t, database, "split-peer")
	third := seedTestUser(t, database, "split-third")
	oneToOne, _, err := database.GetOrCreateDMChannel(ctx, member, peer)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	group, err := database.CreateGroupDMChannel(ctx, "crew", member, []int64{member, peer, third})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}

	role, err := database.GetRoleForUser(ctx, member)
	if err != nil || role == nil {
		t.Fatalf("GetRoleForUser: %v", err)
	}
	msg, err := hub.BuildReadyWithRoleForTest(database, member, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}
	var env struct {
		Payload struct {
			Channels []struct {
				ID int64 `json:"id"`
			} `json:"channels"`
			DMChannels []struct {
				ChannelID int64 `json:"channel_id"`
			} `json:"dm_channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.Channels) != 1 || env.Payload.Channels[0].ID != general {
		t.Errorf("channels = %+v, want only guild channel %d", env.Payload.Channels, general)
	}
	dms := map[int64]bool{}
	for _, dm := range env.Payload.DMChannels {
		dms[dm.ChannelID] = true
	}
	if !dms[oneToOne.ID] || !dms[group.ID] {
		t.Errorf("dm_channels = %v, want both %d and the group %d", dms, oneToOne.ID, group.ID)
	}
}
