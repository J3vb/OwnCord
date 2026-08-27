package ws_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestHasChannelPerm_UsesLiveRoleNotConnectSnapshot locks F5: hasChannelPerm must
// resolve the user's CURRENT role, not the role snapshotted onto the Client at
// connect time. Otherwise a user reassigned to a lower role mid-session keeps the
// old role's voice privileges (CONNECT_VOICE / the SPEAK/VIDEO grants baked into
// the LiveKit token) until they reconnect.
func TestHasChannelPerm_UsesLiveRoleNotConnectSnapshot(t *testing.T) {
	hub, database := newHandlerHub(t)

	// Connect-time role: Member (id 4), which carries CONNECT_VOICE.
	user := seedMemberUser(t, database, "demoted")
	chID := seedTestChannel(t, database, "vc-stale")

	// The client's cached user snapshot still points at the Member role — this
	// is exactly the stale state the connection holds after a role reassignment.
	send := make(chan []byte, 4)
	c := ws.NewTestClientWithUser(hub, user, chID, send)

	// Admin reassigns the user to a role WITHOUT CONNECT_VOICE. The live WS
	// connection is not refreshed, so c.user.RoleID is now stale.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (100, 'novoice', NULL, ?, 5, 0)`,
		permissions.ReadMessages,
	); err != nil {
		t.Fatalf("seed novoice role: %v", err)
	}
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET role_id = 100 WHERE id = ?`, user.ID); err != nil {
		t.Fatalf("reassign user role: %v", err)
	}

	if hub.HasChannelPermForTest(c, chID, permissions.ConnectVoice) {
		t.Fatal("hasChannelPerm granted CONNECT_VOICE from the stale connect-time role; it must use the live role")
	}
}
