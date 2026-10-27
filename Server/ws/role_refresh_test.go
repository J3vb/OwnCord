package ws

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// Roles in the migrated schema (see newTimeoutViewFixture): 1 Owner,
// 3 Moderator, 4 Member.
const (
	rrModRole    = 3
	rrMemberRole = 4
)

// rrFixture is a migrated database and a hub wired with a real
// PermissionService, a few text channels, and live clients that carry users
// (the refresh skips a client without one).
type rrFixture struct {
	t        *testing.T
	database *db.DB
	hub      *Hub
	chA, chB int64
	sends    map[int64]chan []byte
	clients  map[int64]*Client
}

// newRRFixture builds the fixture; run starts the hub's Run loop, which also
// starts the role-refresh worker and the dispatch loop.
func newRRFixture(t *testing.T, run bool) *rrFixture {
	t.Helper()
	database, _ := applyTimeoutMuteTestDB(t)
	ctx := context.Background()
	f := &rrFixture{t: t, database: database, sends: map[int64]chan []byte{}, clients: map[int64]*Client{}}
	var err error
	if f.chA, err = database.CreateChannel(ctx, "rr-a", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if f.chB, err = database.CreateChannel(ctx, "rr-b", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	// Members read nothing, so a promotion to Moderator is what grants access.
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = 0 WHERE id = ?`, rrMemberRole); err != nil {
		t.Fatalf("strip member role: %v", err)
	}
	f.hub = newTestHub(t, database, nil, nil)
	f.hub.perms = service.NewPermissionService(database, permissions.NewChecker(database))
	if err := f.hub.perms.RefreshTimeouts(ctx); err != nil {
		t.Fatalf("RefreshTimeouts: %v", err)
	}
	if run {
		go f.hub.Run()
		t.Cleanup(func() {
			f.hub.Stop()
			select {
			case <-f.hub.Done():
			case <-time.After(10 * time.Second):
				t.Error("hub did not finish")
			}
		})
	}
	return f
}

// addUser creates a user in role, connects a client holding held's topic (0:
// none), and returns the user id.
func (f *rrFixture) addUser(name string, role int, held int64) int64 {
	f.t.Helper()
	ctx := context.Background()
	id, err := f.database.CreateUser(ctx, name, "hash", role)
	if err != nil {
		f.t.Fatalf("CreateUser %s: %v", name, err)
	}
	u, err := f.database.GetUserByID(ctx, id)
	if err != nil || u == nil {
		f.t.Fatalf("GetUserByID: %v", err)
	}
	send := make(chan []byte, 1024)
	c := NewTestClientWithUser(f.hub, u, held, send)
	f.hub.mu.Lock()
	f.hub.clients[id] = []*Client{c}
	f.hub.mu.Unlock()
	f.hub.pubsub.Subscribe(c, TopicGlobal)
	f.hub.pubsub.Subscribe(c, UserTopic(id))
	if held > 0 {
		f.hub.pubsub.Subscribe(c, ChannelTopic(held))
	}
	f.sends[id], f.clients[id] = send, c
	return id
}

// setRole commits a role change and invalidates the cache, as a handler does.
func (f *rrFixture) setRole(uid int64, role int) {
	f.t.Helper()
	if err := f.database.UpdateUserRole(context.Background(), uid, int64(role)); err != nil {
		f.t.Fatalf("UpdateUserRole: %v", err)
	}
	f.hub.perms.InvalidateUser(uid)
}

// rrFrame is the part of a frame these tests compare.
type rrFrame struct {
	Type string
	ID   int64  // channel_create / channel_delete: the channel
	Role string // member_update: the role name
	UID  int64  // member_update: the user
	Raw  string
}

func parseRRFrames(raw [][]byte) []rrFrame {
	var out []rrFrame
	for _, m := range raw {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ID     int64  `json:"id"`
				UserID int64  `json:"user_id"`
				Role   string `json:"role"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil {
			continue
		}
		out = append(out, rrFrame{Type: env.Type, ID: env.Payload.ID, Role: env.Payload.Role, UID: env.Payload.UserID, Raw: string(m)})
	}
	return out
}

// drainFrames reads what is queued for uid until the queue stays quiet.
func (f *rrFixture) drainFrames(uid int64) []rrFrame {
	return parseRRFrames(drainChan(f.sends[uid], 60*time.Millisecond))
}

// channelFrames is the channel_create/channel_delete frames as a sorted set of
// "type:id:raw" strings (the raw payload carries the affordances).
func channelFrames(frames []rrFrame) []string {
	var out []string
	for _, fr := range frames {
		if fr.Type == MsgTypeChannelCreate || fr.Type == MsgTypeChannelDelete {
			out = append(out, fr.Type+":"+fr.Raw)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// waitRoleRefreshIdle returns once nothing is pending or running. A round holds
// flushMu for its whole run, so taking it waits the round out.
func waitRoleRefreshIdle(t *testing.T, h *Hub) {
	t.Helper()
	s := &h.roleRefresh
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s.flushMu.Lock()
		s.mu.Lock()
		idle := len(s.pending) == 0 && !s.all && !s.roles
		s.mu.Unlock()
		s.flushMu.Unlock()
		if idle {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("role refresh did not go idle")
}

// gateOnce installs a user gate that blocks the first call until release is
// closed, and closes entered when that call arrives.
func gateOnce(h *Hub) (entered <-chan struct{}, release func()) {
	in, rel := make(chan struct{}), make(chan struct{})
	var once, relOnce sync.Once
	g := func(int64) {
		once.Do(func() {
			close(in)
			<-rel
		})
	}
	h.roleRefresh.userGate.Store(&g)
	return in, func() { relOnce.Do(func() { close(rel) }) }
}

func rrWaitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func roleName(t *testing.T, database *db.DB, id int64) string {
	t.Helper()
	r, err := database.GetRoleByID(context.Background(), id)
	if err != nil || r == nil {
		t.Fatalf("GetRoleByID %d: %v", id, err)
	}
	return r.Name
}

// A second role edit for the same user lands mid-round (edge case 1): the
// round that was running finishes its sends from the state it read, and the
// next round converges on the second edit.
func TestRoleRefresh_EditDuringRoundIsRefreshedAgain(t *testing.T) {
	f := newRRFixture(t, true)
	u := f.addUser("rr-edit", rrMemberRole, f.chA)
	entered, release := gateOnce(f.hub)
	t.Cleanup(release)

	f.setRole(u, rrModRole) // promote
	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}, MemberUpdate: []int64{u}})
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("round 1 never reached the user step")
	}
	f.setRole(u, rrMemberRole) // demote while round 1 sits between verdicts and sends
	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}, MemberUpdate: []int64{u}})
	if !f.hub.roleRefresh.covers(u) {
		t.Error("covers(u) false with a refresh pending")
	}
	release()
	waitRoleRefreshIdle(t, f.hub)
	want := roleName(t, f.database, rrMemberRole)
	var frames []rrFrame
	rrWaitFor(t, "the member_update for the demoted role", func() bool {
		frames = append(frames, f.drainFrames(u)...)
		for _, fr := range frames {
			if fr.Type == MsgTypeMemberUpdate && fr.UID == u {
				return true
			}
		}
		return false
	})

	last := ""
	for _, fr := range frames {
		if (fr.Type == MsgTypeChannelCreate || fr.Type == MsgTypeChannelDelete) && fr.ID == f.chA {
			last = fr.Type
		}
		if fr.Type == MsgTypeMemberUpdate && fr.UID == u && fr.Role != want {
			t.Errorf("member_update carries %q, want the committed %q (read at send time)", fr.Role, want)
		}
	}
	if last != MsgTypeChannelDelete {
		t.Errorf("last sidebar frame for the channel = %q, want channel_delete after the demotion", last)
	}
	if slices.Contains(f.hub.pubsub.TopicsForUser(u), ChannelTopic(f.chA)) {
		t.Error("the demoted user still holds the channel topic after round 2")
	}
	if f.hub.roleRefresh.covers(u) {
		t.Error("covers(u) still true after both rounds")
	}
}

// Revocation comes first: when the first sidebar frame is queued the demoted
// user's topic is gone and its focus cleared, and a held DM topic stays.
func TestRoleRefresh_RevokesHeldTopicsBeforeSending(t *testing.T) {
	f := newRRFixture(t, false)
	ctx := context.Background()
	u := f.addUser("rr-revoke", rrMemberRole, f.chA)
	other := f.addUser("rr-dm-peer", rrMemberRole, 0)
	dm, _, err := f.database.GetOrCreateDMChannel(ctx, u, other)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	f.hub.pubsub.Subscribe(f.clients[u], ChannelTopic(dm.ID))

	var topics []Topic
	var focus int64
	var queued []rrFrame
	g := func(uid int64) {
		topics = f.hub.pubsub.TopicsForUser(uid)
		f.clients[uid].mu.Lock()
		focus = f.clients[uid].channelID
		f.clients[uid].mu.Unlock()
		queued = parseRRFrames(drainChan(f.sends[uid], 10*time.Millisecond))
	}
	f.hub.roleRefresh.userGate.Store(&g)

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}})
	f.hub.flushRoleRefresh(ctx)

	if slices.Contains(topics, ChannelTopic(f.chA)) {
		t.Error("channel topic still held when the first sidebar frame was about to be queued")
	}
	if !slices.Contains(topics, ChannelTopic(dm.ID)) {
		t.Error("the DM topic was revoked by a role change")
	}
	if focus != 0 {
		t.Errorf("focused channel = %d at the gate, want it cleared", focus)
	}
	for _, fr := range queued {
		if fr.Type == MsgTypeChannelCreate {
			t.Errorf("a channel_create was queued before revocation finished: %s", fr.Raw)
		}
	}
	if !slices.ContainsFunc(queued, func(fr rrFrame) bool { return fr.Type == MsgTypeChannelDelete && fr.ID == f.chA }) {
		t.Errorf("the revocation's channel_delete was not queued first: %+v", queued)
	}
}

// Only the affected users get frames, and an affected user gets exactly what
// the synchronous RefreshAllChannelVisibility would send them.
func TestRefreshUsersVisibility_OnlyAffectedUsersGetFrames(t *testing.T) {
	f := newRRFixture(t, false)
	ctx := context.Background()
	// A channel the Moderator role is denied, so the promoted user gets a mix.
	if err := f.database.UpsertChannelOverride(ctx, f.chB, rrModRole, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	a := f.addUser("rr-aff", rrMemberRole, 0)
	bystanders := []int64{
		f.addUser("rr-by1", rrMemberRole, 0),
		f.addUser("rr-by2", rrModRole, 0),
		f.addUser("rr-by3", rrMemberRole, 0),
	}
	f.setRole(a, rrModRole)
	f.hub.perms.InvalidateAll()

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{a}})
	f.hub.flushRoleRefresh(ctx)
	got := channelFrames(f.drainFrames(a))
	if len(got) == 0 {
		t.Fatal("the affected user got no channel frames")
	}
	for _, uid := range bystanders {
		if fr := channelFrames(f.drainFrames(uid)); len(fr) != 0 {
			t.Errorf("unaffected user %d got channel frames: %v", uid, fr)
		}
	}

	f.hub.RefreshAllChannelVisibility()
	want := channelFrames(f.drainFrames(a))
	if !slices.Equal(got, want) {
		t.Errorf("worker frames for the affected user differ from RefreshAllChannelVisibility\n got: %v\nwant: %v", got, want)
	}
	sawCreate, sawDelete := false, false
	for _, s := range got {
		sawCreate = sawCreate || strings.HasPrefix(s, MsgTypeChannelCreate)
		sawDelete = sawDelete || strings.HasPrefix(s, MsgTypeChannelDelete)
	}
	if !sawCreate || !sawDelete {
		t.Errorf("want a mix of channel_create and channel_delete for the promoted user, got %v", got)
	}
}

// 100 enqueues for one user while the worker is not running give one refresh,
// and the user stops being covered once it has run.
func TestRoleRefresh_CoalescesRepeatedEnqueues(t *testing.T) {
	f := newRRFixture(t, false)
	u := f.addUser("rr-coalesce", rrModRole, 0)
	var runs int
	g := func(int64) { runs++ }
	f.hub.roleRefresh.userGate.Store(&g)

	for range 100 {
		f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u}, MemberUpdate: []int64{u}})
	}
	if !f.hub.roleRefresh.covers(u) {
		t.Fatal("covers(u) false while pending")
	}
	f.hub.flushRoleRefresh(context.Background())
	if runs != 1 {
		t.Errorf("refreshes for the user = %d, want 1", runs)
	}
	if f.hub.roleRefresh.covers(u) {
		t.Error("covers(u) still true after the round")
	}
}

// AllConnected counts every connected user as affected, for pending/in-flight
// coverage and for the round itself.
func TestRoleRefresh_AllConnectedCoversEveryUser(t *testing.T) {
	f := newRRFixture(t, false)
	a := f.addUser("rr-all-a", rrModRole, 0)
	b := f.addUser("rr-all-b", rrModRole, 0)
	f.hub.EnqueueRoleRefresh(RoleRefresh{AllConnected: true})
	if !f.hub.roleRefresh.covers(a) || !f.hub.roleRefresh.covers(b) || !f.hub.roleRefresh.covers(9999) {
		t.Error("an all-connected refresh must cover every user while pending")
	}
	f.hub.flushRoleRefresh(context.Background())
	for _, uid := range []int64{a, b} {
		if len(channelFrames(f.drainFrames(uid))) == 0 {
			t.Errorf("user %d got no channel frames from an all-connected refresh", uid)
		}
	}
	if f.hub.roleRefresh.covers(a) {
		t.Error("still covered after the round")
	}
}

// Unaffected moderators keep the list they hold; a promoted user gets the full
// list and a demoted one the own-only list.
func TestRoleRefresh_TimeoutViewsOnlyForAffected(t *testing.T) {
	f := roleChangeFixture(t)
	ctx := context.Background()
	f.hub.ClientForTest(f.modID).timeouts.full.Store(true) // as its ready set it
	f.hub.ClientForTest(f.adminID).timeouts.full.Store(true)
	if err := f.database.UpdateUserRole(ctx, f.byID, rrModRole); err != nil {
		t.Fatalf("promote: %v", err)
	}
	if err := f.database.UpdateUserRole(ctx, f.modID, rrMemberRole); err != nil {
		t.Fatalf("demote: %v", err)
	}
	f.hub.perms.InvalidateUser(f.byID)
	f.hub.perms.InvalidateUser(f.modID)

	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{f.byID, f.modID}})
	f.hub.flushRoleRefresh(ctx)

	if got := timeoutFrames(t, drainChan(f.sends[f.adminID], 80*time.Millisecond)); len(got) != 0 {
		t.Errorf("unaffected moderator got member_timeouts %v, want none", got)
	}
	if got := timeoutFrames(t, drainChan(f.sends[f.targetID], 80*time.Millisecond)); len(got) != 0 {
		t.Errorf("unaffected member got member_timeouts %v, want none", got)
	}
	promoted := timeoutFrames(t, drainChan(f.sends[f.byID], 80*time.Millisecond))
	if len(promoted) != 1 || !slices.Equal(entryIDs(promoted[0]), []int64{f.targetID}) {
		t.Errorf("promoted user frames = %v, want the full list", promoted)
	}
	demoted := timeoutFrames(t, drainChan(f.sends[f.modID], 80*time.Millisecond))
	if len(demoted) != 1 || len(demoted[0]) != 0 {
		t.Errorf("demoted user frames = %v, want one own-only (empty) list", demoted)
	}
}
