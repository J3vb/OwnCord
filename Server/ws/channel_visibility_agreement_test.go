package ws_test

// channel_visibility_agreement_test.go — the audit's explicit ask for backlog
// item 3 (A-2026-07-07): prove that the three channel-visibility sites agree.
// REST ListVisibleChannels, the ws ready payload (buildReady), and reconnect
// replay filtering (computeAllowedChannels) must yield the identical non-DM
// channel set for the same user, so a drift can never leak a private channel.

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

func seedVisibilityUser(t *testing.T, database *db.DB, username string, roleID int) *db.User {
	t.Helper()
	if _, err := database.CreateUser(context.Background(), username, "hash", roleID); err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername(%s): %v", username, err)
	}
	return user
}

func idSet(ids []int64) map[int64]bool {
	m := make(map[int64]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m
}

func sortedKeys(m map[int64]bool) []int64 {
	out := make([]int64, 0, len(m))
	for id := range m {
		out = append(out, id)
	}
	slices.Sort(out)
	return out
}

func TestChannelVisibility_RESTWSAgreement(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubDeps(t, database, limiter, nil)
	svc := service.New(database, limiter)

	// Seed one channel of each server type plus a dm channel (never visible).
	textID, err := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel text: %v", err)
	}
	annID, err := database.CreateChannel(context.Background(), "announce", "announcement", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel announcement: %v", err)
	}
	voiceID, err := database.CreateChannel(context.Background(), "voice", "voice", "", "", 2)
	if err != nil {
		t.Fatalf("CreateChannel voice: %v", err)
	}
	dmID, err := database.CreateChannel(context.Background(), "dm", "dm", "", "", 3)
	if err != nil {
		t.Fatalf("CreateChannel dm: %v", err)
	}

	// Roles from the seeded fixture: Owner(1)=admin bypass, Moderator(3) and
	// Member(4) both have base READ_MESSAGES but not the Administrator bit.
	const (
		roleOwner     = 1
		roleModerator = 3
		roleMember    = 4
	)

	// Member is denied READ on the announcement channel only.
	if err := database.UpsertChannelOverride(context.Background(), annID, roleMember, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride member/announcement: %v", err)
	}
	// Moderator is denied READ on every server channel → sees nothing.
	for _, chID := range []int64{textID, annID, voiceID} {
		if err := database.UpsertChannelOverride(context.Background(), chID, roleModerator, 0, permissions.ReadMessages); err != nil {
			t.Fatalf("UpsertChannelOverride moderator/%d: %v", chID, err)
		}
	}

	cases := []struct {
		name   string
		roleID int
		want   map[int64]bool
	}{
		{"admin sees all server channels", roleOwner, idSet([]int64{textID, annID, voiceID})},
		{"member denied one channel", roleMember, idSet([]int64{textID, voiceID})},
		{"moderator denied everywhere sees none", roleModerator, idSet([]int64{})},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			user := seedVisibilityUser(t, database, "vis-"+tc.name, tc.roleID)
			role, err := database.GetRoleByID(context.Background(), user.RoleID)
			if err != nil || role == nil {
				t.Fatalf("GetRoleByID: %v", err)
			}

			// 1) REST: ListVisibleChannels.
			restChans, err := svc.Channels.ListVisibleChannels(context.Background(), user.ID)
			if err != nil {
				t.Fatalf("ListVisibleChannels: %v", err)
			}
			restSet := make(map[int64]bool, len(restChans))
			for i := range restChans {
				restSet[restChans[i].ID] = true
			}

			// 2) WS ready payload: buildReady's channel list.
			readyRaw, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
			if err != nil {
				t.Fatalf("BuildReadyWithRoleForTest: %v", err)
			}
			var ready struct {
				Payload struct {
					Channels []struct {
						ID int64 `json:"id"`
					} `json:"channels"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(readyRaw, &ready); err != nil {
				t.Fatalf("unmarshal ready: %v", err)
			}
			readySet := make(map[int64]bool, len(ready.Payload.Channels))
			for _, ch := range ready.Payload.Channels {
				readySet[ch.ID] = true
			}

			// 3) Reconnect replay filtering: computeAllowedChannels, minus DMs.
			allowed, err := hub.ComputeAllowedChannelsForTest(database, user)
			if err != nil {
				t.Fatalf("ComputeAllowedChannelsForTest: %v", err)
			}
			replaySet := map[int64]bool{}
			for id := range allowed {
				if id != dmID { // strip DM channels — membership-based, not role-based
					replaySet[id] = true
				}
			}

			// All three must equal the expected set, hence each other.
			for label, got := range map[string]map[int64]bool{
				"REST ListVisibleChannels": restSet,
				"WS buildReady":            readySet,
				"replay computeAllowed":    replaySet,
			} {
				if !equalSets(got, tc.want) {
					t.Errorf("%s = %v, want %v", label, sortedKeys(got), sortedKeys(tc.want))
				}
			}

			// The DM channel must never appear in any site.
			if restSet[dmID] || readySet[dmID] || allowed[dmID] {
				t.Errorf("dm channel %d leaked into a visibility set", dmID)
			}
		})
	}
}

// TestChannelVisibility_UserOverrideAgreement extends the invariant to the
// per-user override layer: the same three sites must agree for two members who
// share a role but carry different channel_user_overrides rows. A per-role memo
// anywhere in the three paths would show up here as a disagreement.
func TestChannelVisibility_UserOverrideAgreement(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubDeps(t, database, limiter, nil)
	svc := service.New(database, limiter)

	openID, err := database.CreateChannel(context.Background(), "open", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel open: %v", err)
	}
	lockedID, err := database.CreateChannel(context.Background(), "locked", "text", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel locked: %v", err)
	}

	const roleMember = 4
	// The role cannot read #locked at all.
	if err := database.UpsertChannelOverride(context.Background(), lockedID, roleMember, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	// Three members of the SAME role, differing only by their user override.
	plain := seedVisibilityUser(t, database, "uo-plain", roleMember)
	granted := seedVisibilityUser(t, database, "uo-granted", roleMember)
	revoked := seedVisibilityUser(t, database, "uo-revoked", roleMember)

	// granted: user allow on the locked channel beats the role deny.
	if err := database.UpsertChannelUserOverride(context.Background(), lockedID, granted.ID, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("UpsertChannelUserOverride granted: %v", err)
	}
	// revoked: user deny on the open channel beats the base READ grant.
	if err := database.UpsertChannelUserOverride(context.Background(), openID, revoked.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride revoked: %v", err)
	}

	cases := []struct {
		name string
		user *db.User
		want map[int64]bool
	}{
		{"no user override sees only the open channel", plain, idSet([]int64{openID})},
		{"user allow reveals the role-denied channel", granted, idSet([]int64{openID, lockedID})},
		{"user deny hides an otherwise readable channel", revoked, idSet([]int64{})},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			role, err := database.GetRoleByID(context.Background(), tc.user.RoleID)
			if err != nil || role == nil {
				t.Fatalf("GetRoleByID: %v", err)
			}

			restChans, err := svc.Channels.ListVisibleChannels(context.Background(), tc.user.ID)
			if err != nil {
				t.Fatalf("ListVisibleChannels: %v", err)
			}
			restSet := make(map[int64]bool, len(restChans))
			for i := range restChans {
				restSet[restChans[i].ID] = true
			}

			readyRaw, err := hub.BuildReadyWithRoleForTest(database, tc.user.ID, role)
			if err != nil {
				t.Fatalf("BuildReadyWithRoleForTest: %v", err)
			}
			var ready struct {
				Payload struct {
					Channels []struct {
						ID int64 `json:"id"`
					} `json:"channels"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(readyRaw, &ready); err != nil {
				t.Fatalf("unmarshal ready: %v", err)
			}
			readySet := make(map[int64]bool, len(ready.Payload.Channels))
			for _, ch := range ready.Payload.Channels {
				readySet[ch.ID] = true
			}

			allowed, err := hub.ComputeAllowedChannelsForTest(database, tc.user)
			if err != nil {
				t.Fatalf("ComputeAllowedChannelsForTest: %v", err)
			}

			for label, got := range map[string]map[int64]bool{
				"REST ListVisibleChannels": restSet,
				"WS buildReady":            readySet,
				"replay computeAllowed":    allowed,
			} {
				if !equalSets(got, tc.want) {
					t.Errorf("%s = %v, want %v", label, sortedKeys(got), sortedKeys(tc.want))
				}
			}
		})
	}
}

func equalSets(a, b map[int64]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}
