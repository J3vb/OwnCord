package ws_test

// serve_ready_error_propagation_test.go — regression test for finding
// OC-0029: buildReady downgraded ListMembers, GetChannelUnreadCounts, and
// GetUserDMChannels failures to a slog.Warn plus an empty value, then still
// built and returned a normal `ready` frame. `ready` is the protocol's
// authoritative full-state snapshot -- dispatcher.ts treats an empty
// dm_channels as "the server always sends this field, so empty means no open
// DMs" and wipes dmStore (and the active channel, if a DM was open) on that
// basis -- so a transient DB error on any of these three queries was
// indistinguishable on the wire from "you genuinely have none".
// ListChannels/ListRoles/GetChannelOverridesFor already do the right thing
// (return the error and abort the handshake so the client retries); these
// three should too.
//
// Each subtest fault-injects exactly one of the three queries by dropping
// the SQLite table only that query (and nothing earlier in buildReady's call
// order) depends on, then asserts buildReady fails instead of shipping a
// falsely-empty snapshot.

import (
	"context"
	"testing"
)

// TestBuildReady_PropagatesListMembersError drops `users`, which ListMembers
// joins against but which nothing earlier in buildReady (ListChannels,
// ListRoles) touches.
func TestBuildReady_PropagatesListMembersError(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-err-members")
	role, err := database.GetRoleByID(context.Background(), user.RoleID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	if _, err := database.ExecContext(context.Background(), `DROP TABLE users`); err != nil {
		t.Fatalf("drop users: %v", err)
	}

	if _, err := hub.BuildReadyWithRoleForTest(database, user.ID, role); err == nil {
		t.Fatal("buildReady must fail the handshake when ListMembers errors, not silently ship an empty member list as if the server genuinely has none")
	}
}

// TestBuildReady_PropagatesUnreadCountsError drops `read_states`, which only
// GetChannelUnreadCounts (and, further down the function, GetUserDMChannels)
// reads -- ListChannels, ListRoles and ListMembers do not.
func TestBuildReady_PropagatesUnreadCountsError(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-err-unread")
	role, err := database.GetRoleByID(context.Background(), user.RoleID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	if _, err := database.ExecContext(context.Background(), `DROP TABLE read_states`); err != nil {
		t.Fatalf("drop read_states: %v", err)
	}

	if _, err := hub.BuildReadyWithRoleForTest(database, user.ID, role); err == nil {
		t.Fatal("buildReady must fail the handshake when GetChannelUnreadCounts errors, not silently ship every channel with unread_count/mention_count zeroed")
	}
}

// TestBuildReady_PropagatesDMChannelsError drops `dm_open_state`, which only
// GetUserDMChannels reads -- nothing else in buildReady's call chain does.
func TestBuildReady_PropagatesDMChannelsError(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-err-dms")
	role, err := database.GetRoleByID(context.Background(), user.RoleID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	if _, err := database.ExecContext(context.Background(), `DROP TABLE dm_open_state`); err != nil {
		t.Fatalf("drop dm_open_state: %v", err)
	}

	if _, err := hub.BuildReadyWithRoleForTest(database, user.ID, role); err == nil {
		t.Fatal("buildReady must fail the handshake when GetUserDMChannels errors, not silently ship dm_channels: [] as if the user genuinely has none")
	}
}
