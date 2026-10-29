package ws

// role_set_handshake_internal_test.go — WP 6.3c. The handshake's role-change
// detection used to compare only the users.role_id mirror, which follows the
// member's TOP role. Adding or removing a lower role changes what the member
// may read without moving it, so those checks compare the held-role set.

import (
	"context"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

// topOnlyRoleID outranks the harvest voice role and grants nothing, so a member
// holding both keeps the voice role as a NON-top role.
const topOnlyRoleID = int64(202)

func TestRefreshUserSnapshot_TracksHeldRoleSet(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "refresh-set-user")
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, 'harvest-top', NULL, 0, 99, 0)`, topOnlyRoleID); err != nil {
		t.Fatalf("seed top role: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	c := newClient(hub, nil, user, "", 0, ctx)
	if err := hub.refreshUserSnapshot(ctx, database, c); err != nil {
		t.Fatalf("refreshUserSnapshot: %v", err)
	}
	if !slices.Equal(c.roleIDs, []int64{harvestVoiceRoleID}) {
		t.Fatalf("roleIDs = %v, want just the voice role", c.roleIDs)
	}

	// A second role arrives: the top moves, and the held set grows.
	if err := database.AddUserRole(ctx, uid, topOnlyRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if err := hub.refreshUserSnapshot(ctx, database, c); err != nil {
		t.Fatalf("refreshUserSnapshot: %v", err)
	}
	if !slices.Equal(c.roleIDs, []int64{topOnlyRoleID, harvestVoiceRoleID}) || c.roleName != "harvest-top" {
		t.Errorf("roleIDs = %v roleName = %q, want [top voice] on harvest-top", c.roleIDs, c.roleName)
	}
}

func TestSameRoleSet(t *testing.T) {
	for _, tc := range []struct {
		name string
		a, b []int64
		want bool
	}{
		{"equal", []int64{3, 4}, []int64{3, 4}, true},
		{"reordered", []int64{3, 4}, []int64{4, 3}, true},
		{"a role removed", []int64{3, 4}, []int64{3}, false},
		{"a role swapped", []int64{3, 4}, []int64{3, 5}, false},
		{"both empty", nil, []int64{}, true},
	} {
		if got := sameRoleSet(tc.a, tc.b); got != tc.want {
			t.Errorf("%s: sameRoleSet(%v, %v) = %v, want %v", tc.name, tc.a, tc.b, got, tc.want)
		}
	}
}

// Removing a role that is not the member's top role in the window between the
// handshake's reads and registerNow leaves the users.role_id mirror unmoved.
// The post-register recheck must still catch it and release the channel only
// that role granted.
func TestFreshConnectFallback_NonTopRoleRemovedPreRegister_RevokesChannel(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "role-set-late-user")
	chID := mustCreateTextChannel(t, database, "role-set-late-channel")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, 'harvest-top', NULL, 0, 99, 0)`, topOnlyRoleID); err != nil {
		t.Fatalf("seed top role: %v", err)
	}
	if err := database.AddUserRole(ctx, uid, topOnlyRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))
	hub.SeedSeq(100)

	// Force the full-ready fallback without touching roles, so the auth-hint
	// channel survives into handleFreshConnect (see the F-2 test above).
	handleReconnectPreRegisterRaceHook = func() { hub.bumpVisibilityWatermark() }
	defer func() { handleReconnectPreRegisterRaceHook = nil }()

	var hookRan bool
	freshConnectPreRegisterRaceHook = func() {
		if hookRan {
			return
		}
		hookRan = true
		// The voice role granted READ; the top role grants nothing.
		if err := database.RemoveUserRole(context.Background(), uid, harvestVoiceRoleID); err != nil {
			t.Errorf("RemoveUserRole: %v", err)
		}
	}
	defer func() { freshConnectPreRegisterRaceHook = nil }()

	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()
	conn := dialAndAuth(t, ctx, srv.URL, token, 99, chID)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok, got %v", typ)
	}
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeReady {
		t.Fatalf("expected ready (forced fallback), got %v", typ)
	}
	if !hookRan {
		t.Fatal("freshConnectPreRegisterRaceHook never fired")
	}
	if user, err := database.GetUserByID(ctx, uid); err != nil || user == nil || user.RoleID != topOnlyRoleID {
		t.Fatalf("users.role_id = %+v, %v, want it unmoved on the top role", user, err)
	}
	waitForRegisteredClient(t, hub, uid)
	assertNotSubscribed(t, hub, uid, chID, "non-top role removed pre-register")
}

// Same race on the REPLAY path: the resume takes the ring-buffer tier, reaches
// the pre-register hook, and a non-top role is removed there. The mirror does
// not move, so only the watermark bump in revokeUnreadableChannels (the admin
// path's revoke pass) can stop the resume from committing to the old
// permissions. The client must end up without the channel.
func TestReconnectReplay_NonTopRoleRemovedPreRegister_DoesNotKeepChannel(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "role-set-replay-user")
	chID := mustCreateTextChannel(t, database, "role-set-replay-channel")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, 'harvest-top', NULL, 0, 99, 0)`, topOnlyRoleID); err != nil {
		t.Fatalf("seed top role: %v", err)
	}
	if err := database.AddUserRole(ctx, uid, topOnlyRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	// Bracket last_seq (99) inside the buffer so the replay tier is used.
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))
	hub.SeedSeq(100)

	var hookRan bool
	handleReconnectPreSeqMuRaceHook = func() {
		if hookRan {
			return
		}
		hookRan = true
		if err := database.RemoveUserRole(context.Background(), uid, harvestVoiceRoleID); err != nil {
			t.Errorf("RemoveUserRole: %v", err)
		}
		// What the service's RevokeUnreadable does: the socket is not yet
		// registered so nothing is revoked live, but the watermark moves.
		hub.revokeUnreadableChannels(uid)
	}
	defer func() { handleReconnectPreSeqMuRaceHook = nil }()

	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()
	conn := dialAndAuth(t, ctx, srv.URL, token, 99, chID)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok, got %v", typ)
	}
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeReady {
		t.Fatalf("expected ready (the watermark bump forces the full fallback), got %v", typ)
	}
	if !hookRan {
		t.Fatal("handleReconnectPreSeqMuRaceHook never fired: the replay tier was not reached")
	}
	if user, err := database.GetUserByID(ctx, uid); err != nil || user == nil || user.RoleID != topOnlyRoleID {
		t.Fatalf("users.role_id = %+v, %v, want it unmoved on the top role", user, err)
	}
	waitForRegisteredClient(t, hub, uid)
	assertNotSubscribed(t, hub, uid, chID, "non-top role removed during replay")
}
