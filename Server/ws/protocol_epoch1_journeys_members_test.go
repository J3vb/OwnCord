package ws_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── member and role frames (WP 7.3c) ───────────────────────────────────────
//
// These journeys drive the real services, then do exactly what the admin
// handlers do after the service call (the helpers below). Keeping that
// hand-off in three helpers means a later move of the fan-out into the
// services (WP 5.1a) changes one place, not five journeys.
//
// After WP 4.4b a role change is ONE Hub.EnqueueRoleRefresh and a hub worker
// settles it. Per affected socket the round is: the sidebar (channel_create
// per visible channel, with that user's affordances), the timeout view
// (member_timeouts), a paced member_update, and roles_update at the end of the
// round. The sidebar and the timeout view are written straight to the
// socket's queue by the worker; member_update and roles_update go through the
// hub's single dispatch loop, which the worker feeds in that order. So on one
// socket the order is fixed by construction and needs no tolerance; each
// trigger below is read on every socket before the next is fired, so nothing
// ties two triggers' frames together.

// roleIDModerator is migration 001's Moderator role (see seedModerator).
const (
	roleIDModerator = 3
	roleIDMember    = 4
)

// applyRoleChange is patchUserApplyRole (admin/handlers_users.go): the service
// call, then the release of the target's held topics and one role refresh.
func (r *epochRig) applyRoleChange(t *testing.T, actorID, targetID, roleID int64) {
	t.Helper()
	if _, err := r.svc.Moderation.ChangeUserRole(context.Background(), actorID, targetID, roleID); err != nil {
		t.Fatalf("ChangeUserRole(%d -> role %d): %v", targetID, roleID, err)
	}
	r.hub.RevokeUnreadableChannels(targetID)
	r.hub.EnqueueRoleRefresh(ws.RoleRefresh{Visibility: []int64{targetID}, MemberUpdate: []int64{targetID}})
}

// applyRoleEdit is handlePatchRole (admin/handlers_roles.go): the service
// call, the holders' cache eviction, and one refresh shaped by what changed.
func (r *epochRig) applyRoleEdit(t *testing.T, actorID, roleID int64, in service.RoleInput) {
	t.Helper()
	ctx := context.Background()
	holders, ok := r.svc.Roles.AffectedUserIDs(ctx, roleID)
	if !ok {
		t.Fatalf("AffectedUserIDs(%d) failed", roleID)
	}
	_, res, err := r.svc.Roles.UpdateRole(ctx, actorID, roleID, in)
	if err != nil {
		t.Fatalf("UpdateRole(%d): %v", roleID, err)
	}
	for _, uid := range holders {
		r.svc.Permissions.InvalidateUser(uid)
	}
	fan := ws.RoleRefresh{Roles: true}
	if res.Renamed {
		fan.MemberUpdate = holders
	}
	if res.PermsChanged {
		fan.Visibility = holders
	}
	r.hub.EnqueueRoleRefresh(fan)
}

// applyBan is patchUserApplyBan (admin/handlers_users.go) for a ban.
func (r *epochRig) applyBan(t *testing.T, actorID, targetID int64) {
	t.Helper()
	if err := r.svc.Moderation.BanUser(context.Background(), actorID, targetID, "fixture ban", nil); err != nil {
		t.Fatalf("BanUser(%d): %v", targetID, err)
	}
	r.hub.BroadcastMemberBan(targetID)
}

// journeyRoleChange records an admin promoting bob to Moderator and demoting
// him again. Each change gives bob (the target) a full refresh round and
// everyone else only the member_update:
//
//   - bob: channel_create for general and Voice (his affordances moved with his
//     role), member_timeouts (a moderator is sent the full list; on the demotion
//     the same frame replaces it with his own-only view), then member_update.
//   - alice: member_update only. roles_update is NOT part of a user's role
//     change (the role list did not move), so it is not recorded here; the
//     role-edit journey freezes it.
func journeyRoleChange(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	for _, roleID := range []int64{roleIDModerator, roleIDMember} {
		r.applyRoleChange(t, aliceID, bobID, roleID)
		b.expect("channel_create")
		b.expect("channel_create")
		b.expect("member_timeouts")
		b.expect("member_update")
		a.expect("member_update")
	}
	a.barrier()
	b.barrier()
}

// journeyRoleEdit records the two shapes of a role edit, both on the Member
// role bob holds and alice (Admin) does not:
//
//   - colour only: the cheap form, roles_update alone, to everyone.
//   - rename plus a permission change (SEND_MESSAGES removed): bob gets the
//     refreshed sidebar (can_send now false), then member_update for the new
//     role name, then roles_update closing the round. alice, not a holder, gets
//     member_update (it goes to everyone) and roles_update, but no sidebar.
//
// The sidebar frames are written straight to bob's socket and member_update /
// roles_update go through the hub's dispatch loop in round order, so the order
// on each socket is deterministic and nothing here needs expectEither.
func journeyRoleEdit(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	role, err := r.db.GetRoleByID(context.Background(), roleIDMember)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID(%d): %v", roleIDMember, err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok)
	color := "#3366cc"
	r.applyRoleEdit(t, aliceID, roleIDMember, service.RoleInput{Color: &color})
	a.expect("roles_update")
	b.expect("roles_update")

	name := "Regular"
	perms := role.Permissions &^ permissions.SendMessages
	r.applyRoleEdit(t, aliceID, roleIDMember, service.RoleInput{Name: &name, Permissions: &perms})
	b.expect("channel_create")
	b.expect("channel_create")
	b.expect("member_update")
	b.expect("roles_update")
	a.expect("member_update")
	a.expect("roles_update")
	a.barrier()
	b.barrier()
}

// journeyUserUpdate records the profile broadcast through the real PATCH
// /api/v1/users/me route, in both forms: alice's update carries every optional
// field (avatar, display name, about, identity key, banner colour), bob's
// carries them as null where he has none. user_update replaces the receiving
// client's copy wholesale, so the nulls are part of the contract. The frame
// reaches both sockets, the sender's included.
func journeyUserUpdate(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	_ = aliceID
	rest := r.mountREST(t)

	a, b := r.recordedPair(t, aliceTok, bobTok)
	rest.do(t, http.MethodPatch, "/api/v1/users/me/", aliceTok, map[string]any{
		"username": "alice", "about": "edited fixture profile text", "banner_color": "#112233",
	}, http.StatusOK)
	a.expect("user_update")
	b.expect("user_update")

	rest.do(t, http.MethodPatch, "/api/v1/users/me/", bobTok, map[string]any{
		"username": "bob", "display_name": "Bob Fixture",
	}, http.StatusOK)
	a.expect("user_update")
	b.expect("user_update")
	a.barrier()
	b.barrier()
}

// journeyMemberBan records a ban twice. carol never connects: her ban is the
// plain broadcast, member_ban to every connected client. bob is connected when
// he is banned, so his socket is told BANNED (an error frame that makes the
// client clear its credentials) and closed.
//
// What the banned socket receives besides that error is a race inside the
// server: member_ban goes through the dispatch loop while the error is queued
// by the caller, and the close can land before or after the dispatch delivers.
// So bob's side records the error alone and the journey asserts only that
// nothing other than error and member_ban reaches him before the close.
func journeyMemberBan(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	carolID, _ := r.seedUser(t, "carol")

	a, b := r.recordedPair(t, aliceTok, bobTok)
	r.applyBan(t, aliceID, carolID)
	a.expect("member_ban")
	b.expect("member_ban")

	r.applyBan(t, aliceID, bobID)
	b.expectBannedClose()
	a.expect("member_ban")
	a.barrier()
}

// expectBannedClose reads a banned socket to its close: it must receive the
// BANNED error (recorded), may receive the member_ban about itself (not
// recorded: whether it arrives before the close is a race), and nothing else.
func (c *wsConn) expectBannedClose() {
	c.t.Helper()
	was := c.record
	c.record = false
	var errFrame map[string]any
	for {
		ctx, cancel := context.WithTimeout(context.Background(), frameDeadline)
		_, raw, err := c.conn.Read(ctx)
		cancel()
		if err != nil {
			if _, isClose := errors.AsType[websocket.CloseError](err); !isClose {
				c.t.Fatalf("conn %q: expected a WebSocket close after the ban, got %v", c.name, err)
			}
			break
		}
		frame := decodeFrame(c.t, raw)
		switch frame["type"] {
		case "error":
			errFrame = frame
		case "member_ban":
		default:
			c.t.Fatalf("conn %q: unexpected %q before the close: %s", c.name, frame["type"], canonicalJSON(c.t, frame))
		}
	}
	c.record = was
	if errFrame == nil {
		c.t.Fatalf("conn %q: closed without the BANNED error frame", c.name)
	}
	if c.record {
		c.tr.add(c.name, "s2c", errFrame)
	}
}

// expectLowAnywhere reads len(ordered)+1 frames: the ordered normal-priority
// frames in exactly that order, plus one LOW-priority frame (low) that may sit
// anywhere among them. It records low first, then ordered. A low frame queued
// alongside normal ones is written whenever the write pump next looks at its
// queues, so its position relative to them is a race (see the note above
// restRig), but the normal frames among themselves are FIFO.
func (c *wsConn) expectLowAnywhere(low string, ordered ...string) {
	c.t.Helper()
	was := c.record
	c.record = false
	frames := make([]map[string]any, 0, len(ordered)+1)
	for range len(ordered) + 1 {
		frames = append(frames, c.read())
	}
	c.record = was

	var lowFrame map[string]any
	rest := make([]map[string]any, 0, len(ordered))
	for _, f := range frames {
		if f["type"] == low && lowFrame == nil {
			lowFrame = f
			continue
		}
		rest = append(rest, f)
	}
	if lowFrame == nil || len(rest) != len(ordered) {
		c.t.Fatalf("conn %q: expected one %q among %v, got %d frames: %v", c.name, low, ordered, len(frames), frameTypes(frames))
	}
	for i, f := range rest {
		if f["type"] != ordered[i] {
			c.t.Fatalf("conn %q: expected %v (plus %q anywhere), got %v", c.name, ordered, low, frameTypes(frames))
		}
	}
	if c.record {
		c.tr.add(c.name, "s2c", lowFrame)
		for _, f := range rest {
			c.tr.add(c.name, "s2c", f)
		}
	}
}

func frameTypes(frames []map[string]any) []any {
	out := make([]any, len(frames))
	for i, f := range frames {
		out[i] = f["type"]
	}
	return out
}

// journeyMemberTimeout records a timeout issued and then lifted, through the
// real moderation service wired to the hub as api/router.go wires it. The
// mod_action here carries expires_at set (the warning in moderation-queue
// carries null), and the same service call fans out three more things:
//
//   - bob (the target): mod_action, member_timeouts (his own entry only; the
//     lift replaces it with an empty list), and a channel_create per visible
//     channel re-sent with can_send false (true again after the lift).
//   - alice (Admin, a moderator): member_timeouts with the full list.
//
// mod_action is LOW priority, the other three are normal, so its place among
// bob's frames is a race: expectLowAnywhere pins the normal frames' order and
// records mod_action first. Each step is read on both sockets before the next.
func journeyMemberTimeout(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	r.seedModerator(t, aliceID)
	r.svc.Moderation.SetNotifier(r.hub)
	ctx := context.Background()

	a, b := r.recordedPair(t, aliceTok, bobTok)
	if _, err := r.svc.Moderation.Timeout(ctx, aliceID, bobID, "fixture timeout", 10*time.Minute, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	b.expectLowAnywhere("mod_action", "member_timeouts", "channel_create", "channel_create")
	a.expect("member_timeouts")

	if err := r.svc.Moderation.LiftTimeout(ctx, aliceID, bobID); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	b.expectLowAnywhere("mod_action", "member_timeouts", "channel_create", "channel_create")
	a.expect("member_timeouts")
	a.barrier()
	b.barrier()
}
