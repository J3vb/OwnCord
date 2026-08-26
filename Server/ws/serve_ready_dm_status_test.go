package ws_test

// serve_ready_dm_status_test.go — regression test for OC-0008: buildReady's
// dm_channels half came straight from database.GetUserDMChannels, which
// applies only db.StatusForViewer — that collapses invisible to offline but
// passes a disconnected user's saved idle/dnd through verbatim. members goes
// through presentableMembers first, which additionally forces offline for
// anyone with no live WebSocket connection (mirroring
// TestReady_DisconnectedMemberWithChosenStatusRendersOffline in
// presence_invisible_test.go, but for the dm_channels field). Before the fix
// a signed-out user who last chose "dnd" or "idle" would show as offline in
// members but still dnd/idle in dm_channels within the very same ready frame.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// dmChannelStatusFor pulls the recipient status for other.ID out of a ready
// payload's dm_channels array, checking both the legacy `recipient` field and
// the group-aware `recipients` array so a fix that only patches one leaks
// through undetected.
func dmChannelStatusFor(t *testing.T, raw []byte, otherID int64) (recipientStatus string, recipientsStatus string, found bool) {
	t.Helper()
	var env struct {
		Payload struct {
			DMChannels []struct {
				Recipient struct {
					ID     int64  `json:"id"`
					Status string `json:"status"`
				} `json:"recipient"`
				Recipients []struct {
					ID     int64  `json:"id"`
					Status string `json:"status"`
				} `json:"recipients"`
			} `json:"dm_channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	for _, dm := range env.Payload.DMChannels {
		if dm.Recipient.ID == otherID {
			recipientStatus = dm.Recipient.Status
			found = true
		}
		for _, r := range dm.Recipients {
			if r.ID == otherID {
				recipientsStatus = r.Status
			}
		}
	}
	return recipientStatus, recipientsStatus, found
}

// TestBuildReady_DMChannelsHidesDisconnectedRecipientStatus pins OC-0008: a DM
// recipient with no live WebSocket connection must render offline in
// dm_channels, exactly as presentableMembers already forces for the members
// array. absent chooses "dnd", then MarkUserDisconnected-equivalent state is
// simulated by simply never registering a client for absent (buildReady's
// connectedUserIDs() only reflects live hub registrations, so an
// unregistered user is indistinguishable from "signed out").
func TestBuildReady_DMChannelsHidesDisconnectedRecipientStatus(t *testing.T) {
	hub, database := newServeHub(t)
	ctx := context.Background()

	viewer := seedServeUser(t, database, "dm-status-viewer")
	absent := seedServeUser(t, database, "dm-status-absent")
	viewerRole, err := database.GetRoleByID(ctx, viewer.RoleID)
	if err != nil || viewerRole == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	// absent chose "dnd" before signing out; the column keeps it (this is
	// exactly what MarkUserDisconnected leaves behind for a non-online status).
	if err := database.UpdateUserStatus(ctx, absent.ID, db.StatusDND); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}

	seedDMChannel(t, database, viewer.ID, absent.ID)

	// Only the viewer has a live connection; absent is never registered, so
	// they must render offline everywhere in this ready payload.
	msg, err := hub.BuildReadyWithRoleForTest(database, viewer.ID, viewerRole)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}

	recipientStatus, recipientsStatus, found := dmChannelStatusFor(t, msg, absent.ID)
	if !found {
		t.Fatalf("ready payload's dm_channels is missing recipient %d", absent.ID)
	}
	if recipientStatus != db.StatusOffline {
		t.Errorf("dm_channels[].recipient.status = %q, want %q (disconnected member must render offline, same rule presentableMembers applies to the members array)", recipientStatus, db.StatusOffline)
	}
	if recipientsStatus != db.StatusOffline {
		t.Errorf("dm_channels[].recipients[].status = %q, want %q", recipientsStatus, db.StatusOffline)
	}
}
