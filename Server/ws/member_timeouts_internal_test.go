package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// timeoutViewFixture is a migrated database, a hub wired with a real
// PermissionService, and a ModerationService sharing that service so its
// mirror refreshes are the ones the hub's publishes read. Four live clients:
// an Owner (administrator), a Moderator-role user, the timeout target and a
// bystander (both Member role).
type timeoutViewFixture struct {
	database                       *db.DB
	hub                            *Hub
	mod                            *service.ModerationService
	adminID, modID, targetID, byID int64
	sends                          map[int64]chan []byte
}

func newTimeoutViewFixture(t *testing.T) *timeoutViewFixture {
	t.Helper()
	database, _ := applyTimeoutMuteTestDB(t)
	ctx := context.Background()
	mk := func(name string, role int) int64 {
		id, err := database.CreateUser(ctx, name, "hash", role)
		if err != nil {
			t.Fatalf("CreateUser %s: %v", name, err)
		}
		return id
	}
	f := &timeoutViewFixture{database: database, sends: map[int64]chan []byte{}}
	f.adminID = mk("tv-admin", 1)
	f.modID = mk("tv-mod", 3)
	f.targetID = mk("tv-target", 4)
	f.byID = mk("tv-bystander", 4)
	f.hub = newTestHub(t, database, nil, nil)
	f.hub.perms = service.NewPermissionService(database, permissions.NewChecker(database))
	if err := f.hub.perms.RefreshTimeouts(ctx); err != nil {
		t.Fatalf("RefreshTimeouts: %v", err)
	}
	for _, id := range []int64{f.adminID, f.modID, f.targetID, f.byID} {
		f.sends[id] = registerEmitTestClient(f.hub, id, 0)
	}
	f.mod = service.NewModerationService(database, f.hub.perms)
	f.mod.SetNotifier(f.hub)
	return f
}

// timeoutFrames returns the member_timeouts payloads in raw, in order.
func timeoutFrames(t *testing.T, raw [][]byte) [][]memberTimeoutEntry {
	t.Helper()
	var out [][]memberTimeoutEntry
	for _, m := range raw {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				Timeouts []memberTimeoutEntry `json:"timeouts"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil || env.Type != MsgTypeMemberTimeouts {
			continue
		}
		if env.Payload.Timeouts == nil {
			t.Fatalf("member_timeouts carries a null list: %s", m)
		}
		out = append(out, env.Payload.Timeouts)
	}
	return out
}

func entryIDs(es []memberTimeoutEntry) []int64 {
	ids := make([]int64, 0, len(es))
	for _, e := range es {
		ids = append(ids, e.UserID)
	}
	return ids
}

func TestMemberTimeoutsFor_ModeratorAllMemberOwn(t *testing.T) {
	now := time.Now()
	active := map[int64]time.Time{9: now.Add(time.Hour), 3: now.Add(time.Hour), 5: now.Add(-time.Second)}
	if got := entryIDs(memberTimeoutsFor(1, true, active, now)); !reflect.DeepEqual(got, []int64{3, 9}) {
		t.Errorf("moderator view = %v, want [3 9] sorted, expired dropped", got)
	}
	if got := entryIDs(memberTimeoutsFor(9, false, active, now)); !reflect.DeepEqual(got, []int64{9}) {
		t.Errorf("target view = %v, want only [9]", got)
	}
	if got := memberTimeoutsFor(1, false, active, now); got == nil || len(got) != 0 {
		t.Errorf("bystander view = %#v, want an empty non-nil slice", got)
	}
	if got := memberTimeoutsFor(1, true, nil, now); got == nil || len(got) != 0 {
		t.Errorf("empty view = %#v, want an empty non-nil slice", got)
	}
}

// readyTimeoutsOf builds userID's ready frame and returns its member_timeouts
// value as raw JSON plus the decoded entries.
func readyTimeoutsOf(t *testing.T, f *timeoutViewFixture, userID int64) (string, []memberTimeoutEntry) {
	t.Helper()
	role, err := f.database.GetRoleForUser(context.Background(), userID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleForUser: %v", err)
	}
	frame, err := f.hub.BuildReadyWithRoleForTest(f.database, userID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}
	var env struct {
		Payload map[string]json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(frame, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	raw, ok := env.Payload["member_timeouts"]
	if !ok {
		t.Fatalf("ready has no member_timeouts: %s", frame)
	}
	if i, j := bytes.Index(frame, []byte(`"member_timeouts"`)), bytes.Index(frame, []byte(`"members"`)); i < 0 || j < i {
		t.Fatalf("member_timeouts must sort before members in the ready bytes")
	}
	var es []memberTimeoutEntry
	if err := json.Unmarshal(raw, &es); err != nil {
		t.Fatalf("unmarshal member_timeouts: %v", err)
	}
	return string(raw), es
}

func TestBuildReady_MemberTimeouts_EmptyArray(t *testing.T) {
	f := newTimeoutViewFixture(t)
	for _, id := range []int64{f.adminID, f.modID, f.targetID} {
		if raw, _ := readyTimeoutsOf(t, f, id); raw != "[]" {
			t.Errorf("user %d: member_timeouts = %s, want []", id, raw)
		}
	}
}

func issueTimeout(t *testing.T, f *timeoutViewFixture, target int64) {
	t.Helper()
	if _, err := f.mod.Timeout(context.Background(), f.adminID, target, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
}

func TestBuildReady_MemberTimeouts_ModeratorSeesAll(t *testing.T) {
	f := newTimeoutViewFixture(t)
	issueTimeout(t, f, f.targetID)
	issueTimeout(t, f, f.byID)
	_, es := readyTimeoutsOf(t, f, f.modID)
	if got := entryIDs(es); !reflect.DeepEqual(got, []int64{f.targetID, f.byID}) {
		t.Fatalf("moderator ready lists %v, want both timed-out members", got)
	}
	if _, err := time.Parse(time.RFC3339, es[0].ExpiresAt); err != nil {
		t.Errorf("expires_at %q is not RFC 3339: %v", es[0].ExpiresAt, err)
	}
}

func TestBuildReady_MemberTimeouts_MemberSeesOwnOnly(t *testing.T) {
	f := newTimeoutViewFixture(t)
	issueTimeout(t, f, f.targetID)
	issueTimeout(t, f, f.byID)
	if _, es := readyTimeoutsOf(t, f, f.targetID); !reflect.DeepEqual(entryIDs(es), []int64{f.targetID}) {
		t.Errorf("target ready lists %v, want only itself", entryIDs(es))
	}
	// A third, untimed-out member learns nothing.
	extra, err := f.database.CreateUser(context.Background(), "tv-extra", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if raw, _ := readyTimeoutsOf(t, f, extra); raw != "[]" {
		t.Errorf("uninvolved member ready member_timeouts = %s, want []", raw)
	}
}

func TestBuildReady_MemberTimeouts_AdminSeesAll(t *testing.T) {
	f := newTimeoutViewFixture(t)
	issueTimeout(t, f, f.targetID)
	if _, es := readyTimeoutsOf(t, f, f.adminID); !reflect.DeepEqual(entryIDs(es), []int64{f.targetID}) {
		t.Errorf("administrator ready lists %v, want the timed-out member", entryIDs(es))
	}
}

func TestNotifyModAction_PublishesToModeratorsAndTargetOnly(t *testing.T) {
	f := newTimeoutViewFixture(t)
	issueTimeout(t, f, f.targetID)

	for _, id := range []int64{f.adminID, f.modID} {
		fr := timeoutFrames(t, drainChan(f.sends[id], 100*time.Millisecond))
		if len(fr) != 1 || !reflect.DeepEqual(entryIDs(fr[0]), []int64{f.targetID}) {
			t.Errorf("moderator %d frames = %v, want one list with the target", id, fr)
		}
	}
	if fr := timeoutFrames(t, drainChan(f.sends[f.targetID], 100*time.Millisecond)); len(fr) != 1 ||
		!reflect.DeepEqual(entryIDs(fr[0]), []int64{f.targetID}) {
		t.Errorf("target frames = %v, want one list with its own entry", fr)
	}
	if got := drainChan(f.sends[f.byID], 100*time.Millisecond); len(got) != 0 {
		t.Errorf("bystander received %d frames, want none: %s", len(got), got)
	}
}

func TestTimeoutLiftAndExpiry_PublishRemoval(t *testing.T) {
	t.Parallel()
	f := newTimeoutViewFixture(t)
	ctx := context.Background()
	issueTimeout(t, f, f.targetID)
	drainChan(f.sends[f.modID], 50*time.Millisecond)

	if err := f.mod.LiftTimeout(ctx, f.adminID, f.targetID); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	fr := timeoutFrames(t, drainChan(f.sends[f.modID], 100*time.Millisecond))
	if len(fr) != 1 || len(fr[0]) != 0 {
		t.Fatalf("after a lift the moderator got %v, want one empty list", fr)
	}

	// Natural expiry: below Timeout's one-minute floor, so written to the
	// ledger directly and announced the way Timeout announces it.
	expires := time.Now().Add(1500 * time.Millisecond)
	id, _, err := f.database.TimeoutUser(ctx, f.targetID, f.adminID, nil, "brief", expires)
	if err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	if err := f.hub.perms.RefreshTimeouts(ctx); err != nil {
		t.Fatalf("RefreshTimeouts: %v", err)
	}
	f.hub.NotifyModAction(f.targetID, id, "timeout", "brief", &expires)
	fr = timeoutFrames(t, drainChan(f.sends[f.modID], 4*time.Second))
	if len(fr) != 2 || len(fr[0]) != 1 || len(fr[1]) != 0 {
		t.Fatalf("moderator frames = %v, want [target] then [] at expiry", fr)
	}
}

// collector drains a client's channel in the background so a burst cannot
// overflow it (sendMsg closes a client whose buffer is full).
type collector struct {
	mu   sync.Mutex
	last []memberTimeoutEntry
	seen bool
	done chan struct{}
	stop chan struct{}
}

func collect(t *testing.T, ch chan []byte) *collector {
	c := &collector{done: make(chan struct{}), stop: make(chan struct{})}
	go func() {
		defer close(c.done)
		for {
			select {
			case m := <-ch:
				var env struct {
					Type    string `json:"type"`
					Payload struct {
						Timeouts []memberTimeoutEntry `json:"timeouts"`
					} `json:"payload"`
				}
				if json.Unmarshal(m, &env) == nil && env.Type == MsgTypeMemberTimeouts {
					c.mu.Lock()
					c.last, c.seen = env.Payload.Timeouts, true
					c.mu.Unlock()
				}
			case <-c.stop:
				return
			}
		}
	}()
	t.Cleanup(func() { c.finish() })
	return c
}

func (c *collector) finish() {
	select {
	case <-c.stop:
	default:
		close(c.stop)
	}
	<-c.done
}

// Two moderators issue and lift concurrently: whatever the interleaving, the
// last frame a moderator holds is the newest mirror, and so is the target's.
func TestMemberTimeouts_ConcurrentIssueLiftConverges(t *testing.T) {
	f := newTimeoutViewFixture(t)
	ctx := context.Background()
	col := collect(t, f.sends[f.modID])
	tcol := collect(t, f.sends[f.targetID])
	for round := range 40 {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = f.mod.Timeout(ctx, f.adminID, f.targetID, "r", time.Hour, nil)
		}()
		go func() {
			defer wg.Done()
			_ = f.mod.LiftTimeout(ctx, f.adminID, f.targetID)
		}()
		wg.Wait()
		time.Sleep(20 * time.Millisecond) // let the collector see the last frame
		snap, ok := f.hub.perms.TimeoutSnapshot()
		if !ok {
			t.Fatal("mirror unloaded")
		}
		want := entryIDs(memberTimeoutsFor(f.modID, true, snap, time.Now()))
		col.mu.Lock()
		got := entryIDs(col.last)
		col.mu.Unlock()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("round %d: moderator holds %v, mirror says %v", round, got, want)
		}
		wantOwn := entryIDs(memberTimeoutsFor(f.targetID, false, snap, time.Now()))
		tcol.mu.Lock()
		gotOwn := entryIDs(tcol.last)
		tcol.mu.Unlock()
		if !reflect.DeepEqual(gotOwn, wantOwn) {
			t.Fatalf("round %d: target holds %v, mirror says %v", round, gotOwn, wantOwn)
		}
	}
}

func roleChangeFixture(t *testing.T) *timeoutViewFixture {
	t.Helper()
	f := newTimeoutViewFixture(t)
	issueTimeout(t, f, f.targetID)
	for _, ch := range f.sends {
		drainChan(ch, 30*time.Millisecond)
	}
	return f
}

func TestRoleChange_GrantModerateSendsFullView(t *testing.T) {
	f := roleChangeFixture(t)
	ctx := context.Background()
	if err := f.database.UpdateUserRole(ctx, f.byID, 3); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	f.hub.perms.InvalidateUser(f.byID)
	f.hub.RefreshAllChannelVisibility()

	fr := timeoutFrames(t, drainChan(f.sends[f.byID], 100*time.Millisecond))
	if len(fr) != 1 || !reflect.DeepEqual(entryIDs(fr[0]), []int64{f.targetID}) {
		t.Fatalf("new moderator frames = %v, want the full list", fr)
	}
	if !f.hub.ClientForTest(f.byID).timeouts.full.Load() {
		t.Error("timeouts.full not set after the grant")
	}
	// A client that never was a moderator is left alone.
	if got := timeoutFrames(t, drainChan(f.sends[f.targetID], 100*time.Millisecond)); len(got) != 0 {
		t.Errorf("non-moderator target got %v on a role refresh, want nothing", got)
	}
}

func TestRoleChange_RevokeSendsOwnOnly(t *testing.T) {
	f := roleChangeFixture(t)
	ctx := context.Background()
	f.hub.ClientForTest(f.modID).timeouts.full.Store(true) // as its ready set it
	if err := f.database.UpdateUserRole(ctx, f.modID, 4); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	f.hub.perms.InvalidateUser(f.modID)
	f.hub.RefreshAllChannelVisibility()

	fr := timeoutFrames(t, drainChan(f.sends[f.modID], 100*time.Millisecond))
	if len(fr) != 1 || len(fr[0]) != 0 {
		t.Fatalf("ex-moderator frames = %v, want one own-only (empty) list", fr)
	}
	if f.hub.ClientForTest(f.modID).timeouts.full.Load() {
		t.Error("timeouts.full still set after the revoke")
	}
	// Second refresh: the flag is down, so nothing more is sent.
	f.hub.RefreshAllChannelVisibility()
	if got := timeoutFrames(t, drainChan(f.sends[f.modID], 100*time.Millisecond)); len(got) != 0 {
		t.Errorf("repeat refresh re-sent %v to a non-moderator", got)
	}
}

// A moderator offline while a timeout is issued resumes onto a full ready
// (the publish bumped the visibility watermark) that carries the list.
func TestResume_AcrossTimeout_FullReadyCarriesMemberTimeouts(t *testing.T) {
	t.Parallel()
	database := newTeardownTestDB(t)
	ctx := context.Background()
	adminID, err := database.CreateUser(ctx, "rs-admin", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	modID, err := database.CreateUser(ctx, "rs-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	targetID, err := database.CreateUser(ctx, "rs-target", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "rs-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, modID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	hub.perms = service.NewPermissionService(database, permissions.NewChecker(database))
	go hub.Run()
	t.Cleanup(hub.Stop)
	rb := hub.ReplayBuffer()
	for seq := uint64(96); seq <= 98; seq++ {
		rb.Push(seq, chID, []byte(`{"seq":`+itoaTest(int64(seq))+`,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"x"}}`))
	}
	hub.SeedSeq(98)

	mod := service.NewModerationService(database, hub.perms)
	mod.SetNotifier(hub)
	if _, err := mod.Timeout(ctx, adminID, targetID, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}

	frames := dialAndResume(t, hub, token, 97)
	var ready []byte
	for _, fr := range frames {
		if strings.Contains(string(fr), `"type":"ready"`) {
			ready = fr
		}
	}
	if ready == nil {
		t.Fatalf("resume across a timeout did not fall back to a full ready; got %d frames", len(frames))
	}
	var env struct {
		Payload struct {
			Timeouts []memberTimeoutEntry `json:"member_timeouts"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(ready, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if !reflect.DeepEqual(entryIDs(env.Payload.Timeouts), []int64{targetID}) {
		t.Errorf("resumed ready member_timeouts = %v, want the target", env.Payload.Timeouts)
	}
}
