package ws

// voice_membership_harness_test.go — ARCH-03h: a test harness for voice
// membership's central invariant, which gains two new writers with RT-3 (the
// polling reaper) and RT-8 (the reconnect grace window).
//
// INVARIANT (three-way agreement, checked after every driver step):
//
//	Client.voiceChID ⇔ voice_states row ⇔ SFU participant
//
// Concretely, for every user the harness has touched:
//
//	A  the client's in-memory voice channel (getVoiceChID) is the channel its
//	   voice_states row names (0 ⇔ no row) — a row without a client is a ghost;
//	   a client without a row is a lost member that nothing reaps;
//	B  a live, completed membership has exactly one SFU participant, and every
//	   SFU participant belongs to a live, completed membership — a participant
//	   whose membership the server has torn down is a ghost, and one the server
//	   never removed is a leak.
//
// The harness drives the real entry points — voice_join / voice_leave frames
// through handleMessage, the reconnect handoff (registerNow), a moderator
// eviction, the stale sweep, rollback, and disconnect teardown — against a
// fake room service that records the SFU's participant set. It does not
// re-implement any membership rule: each op calls the production function and
// the checks read the three views back.
//
// RT-3's reaper tests extend this file: the fake room service answers
// ListParticipants, and sweep() below is the sweep entry point they drive.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	lkproto "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── fake room service ──────────────────────────────────────────────────────

// fakeSFU is a fake LiveKit room service: it records the SFU's participant
// set so the harness can read the third leg of the invariant. Only the RPCs
// the hub actually calls are implemented; anything else is recorded and fails
// the next check — a new hub RPC must be added here deliberately rather than
// silently no-op'd.
type fakeSFU struct {
	mu           sync.Mutex
	participants map[string]map[string]struct{} // room -> identity set
	unhandled    []string                       // RPC methods the fake does not implement
	listFails    bool                           // when set, ListParticipants answers an error
	onList       func()                         // when set, runs once at the next ListParticipants, before it answers
}

// beforeNextList runs fn once, inside the next ListParticipants, before the
// fake reads the room — to interleave a join with a reconcile tick.
func (f *fakeSFU) beforeNextList(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onList = fn
}

// setListFailure makes ListParticipants answer an error until cleared, to
// model a transient/unavailable SFU for the reconciler's failure handling.
func (f *fakeSFU) setListFailure(v bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listFails = v
}

func newFakeSFU() *fakeSFU {
	return &fakeSFU{participants: map[string]map[string]struct{}{}}
}

func (f *fakeSFU) add(room, identity string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.participants[room] == nil {
		f.participants[room] = map[string]struct{}{}
	}
	f.participants[room][identity] = struct{}{}
}

func (f *fakeSFU) remove(room, identity string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.participants[room], identity)
}

func (f *fakeSFU) has(room, identity string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.participants[room][identity]
	return ok
}

// identities returns the sorted SFU identities in a room.
func (f *fakeSFU) identities(room string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.participants[room]))
	for id := range f.participants[room] {
		out = append(out, id)
	}
	return out
}

// unhandledRPCs returns the RPC methods the hub called that the fake does not
// implement.
func (f *fakeSFU) unhandledRPCs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.unhandled...)
}

// serve starts the fake as a Twirp room service and returns a LiveKitClient
// pointed at it. The client is what the hub calls; the fake is what the
// harness reads.
func (f *fakeSFU) serve(t *testing.T) *LiveKitClient {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "harness-key-test",
		LiveKitAPISecret: "harness-secret-0123456789abcdef",
		LiveKitURL:       "ws://" + srv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	return lk
}

func (f *fakeSFU) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	marshal := func(msg proto.Message) {
		out, _ := proto.Marshal(msg)
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out)
	}
	switch method {
	case "ListParticipants":
		var req lkproto.ListParticipantsRequest
		_ = proto.Unmarshal(body, &req)
		f.mu.Lock()
		fails := f.listFails
		hook := f.onList
		f.onList = nil
		f.mu.Unlock()
		if hook != nil {
			hook()
		}
		if fails {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"code":"internal","msg":"fake SFU: ListParticipants failure"}`))
			return
		}
		ids := f.identities(req.GetRoom())
		ps := make([]*lkproto.ParticipantInfo, 0, len(ids))
		for _, id := range ids {
			ps = append(ps, &lkproto.ParticipantInfo{Identity: id})
		}
		marshal(&lkproto.ListParticipantsResponse{Participants: ps})
	case "RemoveParticipant":
		var req lkproto.RoomParticipantIdentity
		_ = proto.Unmarshal(body, &req)
		f.remove(req.GetRoom(), req.GetIdentity())
		marshal(&lkproto.RemoveParticipantResponse{})
	case "UpdateParticipant":
		var req lkproto.UpdateParticipantRequest
		_ = proto.Unmarshal(body, &req)
		marshal(&lkproto.ParticipantInfo{Identity: req.GetIdentity()})
	case "ListRooms":
		marshal(&lkproto.ListRoomsResponse{})
	default:
		f.mu.Lock()
		f.unhandled = append(f.unhandled, method)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"not_found","msg":"fake SFU: unhandled ` + method + `"}`))
	}
}

// ─── harness ────────────────────────────────────────────────────────────────

// vmMember is one user's three membership views: the live *Client (nil while
// disconnected), the DB row, and the SFU participant the fake holds.
type vmMember struct {
	userID int64
	name   string
	c      *Client
}

// vmHarness drives voice membership against a real hub, a real SQLite DB and
// a fake SFU, then checks the three-way invariant after every step.
type vmHarness struct {
	t        *testing.T
	hub      *Hub
	db       *db.DB
	sfu      *fakeSFU
	members  []*vmMember
	byUserID map[int64]*vmMember
	chanIDs  []int64 // every channel the harness created, for the subscription check
	step     int
	trace    []string
}

// newVMHarness builds a harness over n seeded users and a live hub loop.
// Each user is seeded with CONNECT_VOICE and gets a send channel large enough
// to absorb the voice fan-out without the overflow kick.
func newVMHarness(t *testing.T, n int) *vmHarness {
	t.Helper()
	database := newHarvestVoiceDB(t)
	sfu := newFakeSFU()
	lk := sfu.serve(t)

	hub := newTestHubWith(t, HubOptions{DB: database, Limiter: auth.NewRateLimiter(), LiveKit: lk})
	go hub.Run()
	t.Cleanup(hub.Stop)

	h := &vmHarness{t: t, hub: hub, db: database, sfu: sfu, byUserID: map[int64]*vmMember{}}
	for i := range n {
		name := fmt.Sprintf("vm-user-%d", i)
		uid := seedHarvestVoiceUser(t, database, name)
		m := &vmMember{userID: uid, name: name}
		h.members = append(h.members, m)
		h.byUserID[uid] = m
	}
	return h
}

// chanOf creates a voice channel in the harness DB.
func (h *vmHarness) chanOf(name string) int64 {
	h.t.Helper()
	id := mustCreateVoiceChannel(h.t, h.db, name)
	h.chanIDs = append(h.chanIDs, id)
	return id
}

func (h *vmHarness) note(format string, args ...any) {
	h.trace = append(h.trace, fmt.Sprintf("#%d ", h.step)+fmt.Sprintf(format, args...))
	if len(h.trace) > 24 {
		h.trace = h.trace[1:]
	}
}

// failf reports a harness failure with the last steps, the same recovery aid
// hub_sim_test.go prints.
func (h *vmHarness) failf(format string, args ...any) {
	h.t.Helper()
	h.t.Fatalf("voice membership harness: step %d: %s\nlast steps:\n  %s",
		h.step, fmt.Sprintf(format, args...), strings.Join(h.trace, "\n  "))
}

// connect registers a fresh connection for m (lastSeq 0: a fresh connect) and
// marks the harness's view of which *Client is live.
func (h *vmHarness) connect(m *vmMember) {
	h.t.Helper()
	c := NewTestClient(h.hub, m.userID, make(chan []byte, 512))
	user, err := h.db.GetUserByID(context.Background(), m.userID)
	if err != nil || user == nil {
		h.t.Fatalf("GetUserByID(%d): %v", m.userID, err)
	}
	c.user = user
	h.hub.Register(c)
	// Wait for the hub loop to install c, so the next step sees it.
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.GetClient(m.userID) != c {
		if time.Now().After(deadline) {
			h.failf("%s: connection never registered", m.name)
		}
		time.Sleep(time.Millisecond)
	}
	m.c = c
}

// join drives a voice_join frame through the real dispatch and models the
// join's SFU arrival: once the server has completed the join and delivered
// the token, the participant appears in the fake. A refused or in-flight join
// leaves no participant (GenerateToken is a local mint; the participant only
// exists after the client's own SFU connect, which completion implies).
// It returns whether the join completed.
func (h *vmHarness) join(m *vmMember, chID int64) bool {
	h.step++
	h.t.Helper()
	if m.c == nil {
		h.failf("%s: join with no live client", m.name)
	}
	h.hub.handleMessage(m.c, voiceFrame(h.t, "voice_join", fmt.Sprintf("join-%d", h.step), map[string]any{"channel_id": chID}))
	ch, token := m.c.getVoiceState()
	completed := ch == chID && m.c.voiceJoinCompletedForHarness()
	if completed {
		h.sfu.add(RoomName(chID), participantIdentity(m.userID, token))
		h.note("join %s -> ch%d token=%s", m.name, chID, token)
	} else {
		h.note("join %s ch%d did not complete (in %d, completed=%v)", m.name, chID, ch, m.c.voiceJoinCompletedForHarness())
	}
	h.check()
	return completed
}

// leave drives a client voice_leave frame.
func (h *vmHarness) leave(m *vmMember) {
	h.step++
	h.t.Helper()
	h.hub.handleMessage(m.c, voiceFrame(h.t, "voice_leave", fmt.Sprintf("leave-%d", h.step), map[string]any{}))
	h.note("leave %s", m.name)
	h.check()
}

// disconnect tears down m's connection the way readPump's defer does: the
// hub's teardown runs (which removes the SFU participant on a background
// goroutine), then m has no live client. With teardown false the voice
// teardown is missed, leaving the row and the SFU participant for the sweep.
//
// RT-8: the voice teardown now goes through leaveVoiceOnDisconnect, which
// parks a COMPLETED membership in the grace window instead of removing it at
// once. `disconnect` therefore no longer models the final state of a socket
// drop for a graced member — use disconnectGraced and expireGrace to drive
// that window explicitly.
func (h *vmHarness) disconnect(m *vmMember, teardown bool) {
	h.step++
	h.t.Helper()
	ctx := context.Background()
	voiceChID := m.c.getVoiceChID()
	replaced := h.hub.unregisterNow(m.c)
	if teardown && voiceChID != 0 && !replaced {
		h.hub.leaveVoiceOnDisconnect(ctx, m.c, voiceLeaveReasonDisconnect)
	}
	m.c = nil
	h.note("disconnect %s (was ch%d, teardown=%v)", m.name, voiceChID, teardown)
	h.check()
}

// expireGrace force-expires m's parked grace window, running the deferred
// teardown now instead of waiting the real 15 s.
func (h *vmHarness) expireGrace(m *vmMember) {
	h.step++
	h.t.Helper()
	h.hub.leaveParkedVoice(context.Background(), h.hub.voiceGrace.take(m.userID), voiceLeaveReasonGraceExpired)
	h.note("expireGrace %s", m.name)
	h.check()
}

// resume models a reconnecting socket arriving after the previous one is
// fully gone (the RT-8 case: the close was observed before the new socket
// registered, so there is no old *Client for registerNow to transfer from).
// lastSeq > 0 makes it a resume, so it may inherit a parked grace membership.
func (h *vmHarness) resume(m *vmMember) {
	h.step++
	h.t.Helper()
	if m.c != nil {
		h.failf("%s: resume with a live client", m.name)
	}
	c := NewTestClient(h.hub, m.userID, make(chan []byte, 512))
	c.lastSeq = 1 // a resume, not a fresh connect
	user, err := h.db.GetUserByID(context.Background(), m.userID)
	if err != nil || user == nil {
		h.t.Fatalf("GetUserByID(%d): %v", m.userID, err)
	}
	c.user = user
	h.hub.dropOrphanVoiceGrace(context.Background(), m.userID)
	h.hub.registerNow(c, nil)
	m.c = c
	h.note("resume %s", m.name)
	h.check()
}

// reconnect models a network reconnect: a new socket registered through
// registerNow with a non-zero lastSeq, which may transfer the old connection's
// voice state. The old connection is then torn down as replaced.
func (h *vmHarness) reconnect(m *vmMember) {
	h.step++
	h.t.Helper()
	old := m.c
	oldChID, _ := old.getVoiceState()

	c := NewTestClient(h.hub, m.userID, make(chan []byte, 512))
	c.lastSeq = 1 // a resume, not a fresh connect
	user, err := h.db.GetUserByID(context.Background(), m.userID)
	if err != nil || user == nil {
		h.t.Fatalf("GetUserByID(%d): %v", m.userID, err)
	}
	c.user = user
	h.hub.registerNow(c, nil)
	m.c = c

	// The old socket's readPump defer: replaced, so it does NOT run the leave
	// teardown (the replacement owns the transferred session). The SFU
	// participant's identity carries the join token, which the transfer keeps.
	h.hub.unregisterNow(old)

	newCh, newToken := c.getVoiceState()
	h.note("reconnect %s: ch%d -> ch%d token=%s", m.name, oldChID, newCh, newToken)
	h.check()
}

// evict runs a moderator-style eviction through the scoped hub method. The
// teardown's RemoveParticipant reaches the fake on a background goroutine.
func (h *vmHarness) evict(m *vmMember) {
	h.step++
	h.t.Helper()
	ch, _ := m.c.getVoiceState()
	if !h.hub.DisconnectFromVoiceInChannel(context.Background(), m.userID, ch, voiceLeaveReasonModerator) {
		h.failf("%s: moderator eviction reported no eviction (in ch%d)", m.name, ch)
	}
	h.note("evict %s from ch%d", m.name, ch)
	h.check()
}

// rollback undoes an in-flight join through the production rollback, then
// removes the participant that never reached the SFU (rollbackVoiceJoin does
// not call RemoveParticipant — the join never got a token).
//
// It also asserts OC-0267: rollbackVoiceJoin's compensating voice_leave must
// reach the leaver itself, whose client state was just cleared (so the plain
// READ-plus-still-in-room audience can no longer see them).
func (h *vmHarness) rollback(m *vmMember, chID int64) {
	h.step++
	h.t.Helper()
	_, token := m.c.getVoiceState()
	h.hub.rollbackVoiceJoin(context.Background(), m.c, chID, token, true)
	h.sfu.remove(RoomName(chID), participantIdentity(m.userID, token))
	if !drainHasVoiceLeave(m.c.send, chID, m.userID) {
		h.failf("%s: rollback broadcast no voice_leave for ch%d to the leaver (OC-0267)", m.name, chID)
	}
	h.note("rollback %s ch%d", m.name, chID)
	h.check()
}

// abortedSwitch reproduces OC-0034's sequence: the client's join token is
// missing (leaveVoiceChannelWithRetry skips the delete), so a switch aborts
// with the old row still in the DB. The client must be left CLEARED — not
// restored to a session the voice_leave already tore down — and the stale row
// must then be reapable by the sweep.
func (h *vmHarness) abortedSwitch(m *vmMember, fromCh, toCh int64) {
	h.step++
	h.t.Helper()
	ch, _ := m.c.getVoiceState()
	if ch != fromCh {
		h.failf("%s: abortedSwitch precondition: client in ch%d, want ch%d", m.name, ch, fromCh)
	}
	// Drop the join token but keep the channel: the delete short-circuits.
	m.c.setVoiceStateForHarness(fromCh, "")
	h.hub.handleMessage(m.c, voiceFrame(h.t, "voice_join", fmt.Sprintf("join-%d", h.step), map[string]any{"channel_id": toCh}))
	if got := m.c.getVoiceChID(); got != 0 {
		h.failf("%s: aborted switch resurrected a phantom session: client ch%d, want 0 (OC-0034)", m.name, got)
	}
	h.note("abortedSwitch %s ch%d->ch%d (client cleared)", m.name, fromCh, toCh)
	// The stale row is now a row-without-memory ghost; the sweep must reap it.
	h.sweep()
}

// freshConnect models a genuinely fresh reconnect (lastSeq 0) while the old
// connection is still registered, driving the production stale-voice cleanup.
// OC-0252: the old *Client's in-memory state must be cleared alongside the row.
func (h *vmHarness) freshConnect(m *vmMember) {
	h.step++
	h.t.Helper()
	old := m.c
	oldCh, _ := old.getVoiceState()
	oldRow, err := h.db.GetVoiceState(context.Background(), m.userID)
	if err != nil || oldRow == nil {
		h.failf("%s: freshConnect precondition: no row (%v, %v)", m.name, oldRow, err)
	}
	h.hub.freshConnectCleanStaleVoice(context.Background(), old, oldRow)
	if got := old.getVoiceChID(); got != 0 {
		h.failf("%s: fresh-connect cleanup left the old client in ch%d, want 0 (OC-0252)", m.name, got)
	}
	if h.hub.IsVoiceKeyHolder(oldCh, m.userID) {
		h.failf("%s: fresh-connect cleanup left a phantom key holder for ch%d (OC-0252)", m.name, oldCh)
	}
	m.c = nil
	h.note("freshConnect %s (old client cleared from ch%d)", m.name, oldCh)
	h.check()
}

// reconnectIncomplete reproduces OC-0270: a join that committed its row and
// set the client's state, but never reached voiceJoinComplete, is in flight
// on the old connection when a reconnect arrives. The transfer must NOT hand
// the half-finished session to the new socket (its supersession guard would
// then abort the join and strand the row); the sweep must reap the row.
func (h *vmHarness) reconnectIncomplete(m *vmMember, chID int64) {
	h.step++
	h.t.Helper()
	old := m.c
	// The failed/in-flight join's shape: row committed, client state set, but
	// completion never marked (setVoiceState leaves voiceJoinCompleted false).
	row, err := h.db.GetVoiceState(context.Background(), m.userID)
	if err != nil || row == nil {
		h.failf("%s: reconnectIncomplete precondition: no row (%v, %v)", m.name, row, err)
	}
	old.setVoiceStateForHarness(chID, row.JoinedAt)

	c := NewTestClient(h.hub, m.userID, make(chan []byte, 512))
	c.lastSeq = 1
	user, _ := h.db.GetUserByID(context.Background(), m.userID)
	c.user = user
	h.hub.registerNow(c, nil)
	h.hub.unregisterNow(old)
	m.c = c
	if got := c.getVoiceChID(); got != 0 {
		h.failf("%s: reconnect transferred an incomplete voice join (ch%d) that its own supersession guard will strand (OC-0270)", m.name, got)
	}
	h.note("reconnectIncomplete %s (not transferred)", m.name)
	h.sweep()
}

// staleRollback reproduces OC-0044: a stale join's rollback must not delete a
// newer membership the user has since established in a different channel.
// The harness does not model the newer membership's connection, so once the
// row is shown to survive, the sweep reaps it as a row no live client names.
func (h *vmHarness) staleRollback(m *vmMember, staleCh, newCh int64) {
	h.step++
	h.t.Helper()
	// A newer membership, established by another connection, in newCh.
	if err := h.db.JoinVoiceChannel(context.Background(), m.userID, newCh); err != nil {
		h.failf("%s: JoinVoiceChannel(newer): %v", m.name, err)
	}
	newRow, _ := h.db.GetVoiceState(context.Background(), m.userID)
	if newRow == nil {
		h.failf("%s: staleRollback precondition: newer row missing", m.name)
	}
	// The stale rollback, with a token that matches nothing current.
	h.hub.rollbackVoiceJoin(context.Background(), m.c, staleCh, "stale-token-matches-nothing", true)
	got, err := h.db.GetVoiceState(context.Background(), m.userID)
	if err != nil {
		h.failf("%s: GetVoiceState: %v", m.name, err)
	}
	if got == nil || got.ChannelID != newCh || got.JoinedAt != newRow.JoinedAt {
		h.failf("%s: stale rollback destroyed the newer membership (OC-0044): row=%v, want ch%d/%s", m.name, got, newCh, newRow.JoinedAt)
	}
	h.note("staleRollback %s ch%d (newer ch%d survived)", m.name, staleCh, newCh)
	h.sweep()
}

// denyRead removes READ_MESSAGES on chID for the harness role, leaving
// CONNECT_VOICE — the exact combination a voice participant without READ
// access has, which is where a leaver-only broadcast matters (OC-0267).
func (h *vmHarness) denyRead(chID int64) {
	h.t.Helper()
	if err := h.db.UpsertChannelOverride(context.Background(), chID, harvestVoiceRoleID, 0, permissions.ReadMessages); err != nil {
		h.t.Fatalf("UpsertChannelOverride: %v", err)
	}
	// The hub's permission cache must see the override; the harvest hub has no
	// PermissionService, so the live checker reads the override directly.
}

// stashSurvivesJoinFailure reproduces OC-0420: a moderator move stashes a
// mute/deafen on the target's client, then the target's re-join fails (the
// destination is full). The stash must survive for a later join instead of
// being consumed and lost.
func (h *vmHarness) stashSurvivesJoinFailure(m *vmMember, fullCh int64) {
	h.step++
	h.t.Helper()
	m.c.setPendingModFlags(true, false, nil)
	if !h.join(m, fullCh) {
		// The join failed as arranged; the stash must still be there.
		muted, _ := m.c.peekPendingModFlagsForHarness()
		if !muted {
			h.failf("%s: a failed join consumed the moderator mute stash (OC-0420)", m.name)
		}
		h.note("stashSurvives %s (join to full ch%d refused, stash kept)", m.name, fullCh)
	} else {
		h.failf("%s: stashSurvivesJoinFailure precondition: join to full ch%d unexpectedly completed", m.name, fullCh)
	}
	h.check()
}

// sweep runs the production stale-voice sweep, which reaps rows whose client
// no longer names the channel and removes their SFU participants. After it,
// the strict invariant holds with no transient ghost: a row with no live
// client must be gone.
func (h *vmHarness) sweep() {
	h.step++
	h.t.Helper()
	h.hub.sweepStaleVoiceStates()
	if ghost := h.ghostRow(); ghost != "" {
		h.failf("sweep left a ghost: %s", ghost)
	}
	h.note("sweep")
	h.check()
}

// ghostRow returns the first voice_states row naming a user with no live
// client and no parked grace entry, or "" when none. A parked entry (RT-8) is
// deliberately a row with no live client, so it is not a ghost.
func (h *vmHarness) ghostRow() string {
	ctx := context.Background()
	for _, m := range h.members {
		if m.c != nil {
			continue
		}
		row, err := h.db.GetVoiceState(ctx, m.userID)
		if err != nil {
			h.failf("%s: GetVoiceState: %v", m.name, err)
		}
		if row != nil && !h.hub.voiceGrace.has(m.userID, row.ChannelID) {
			return fmt.Sprintf("%s has a voice_states row for ch%d but no live client", m.name, row.ChannelID)
		}
	}
	return ""
}

// check is the three-way oracle. The SFU leg settles asynchronously (the
// teardown's RemoveParticipant runs on its own goroutine), so it retries
// briefly before failing.
func (h *vmHarness) check() {
	h.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var last string
	for {
		if last = h.attempt(); last == "" {
			return
		}
		if time.Now().After(deadline) {
			h.failf("three-way membership invariant violated: %s", last)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// attempt reads the three views back and returns the first disagreement, or
// "" when they agree.
func (h *vmHarness) attempt() string {
	ctx := context.Background()
	rows := map[int64]*db.VoiceState{}
	for _, m := range h.members {
		row, err := h.db.GetVoiceState(ctx, m.userID)
		if err != nil {
			return fmt.Sprintf("%s: GetVoiceState: %v", m.name, err)
		}
		rows[m.userID] = row
		if m.c == nil {
			continue
		}
		ch, token := m.c.getVoiceState()
		switch {
		case ch == 0 && row != nil:
			// The paths that deliberately leave such a row (OC-0034's aborted
			// switch, OC-0270's untransferred join) sweep before checking.
			return fmt.Sprintf("%s: voice_states row for ch%d but the live client is not in voice (ghost row)", m.name, row.ChannelID)
		case ch != 0 && row == nil:
			return fmt.Sprintf("%s: client says ch%d but there is no voice_states row (lost member)", m.name, ch)
		case ch != 0 && row.ChannelID != ch:
			return fmt.Sprintf("%s: client ch%d disagrees with row ch%d", m.name, ch, row.ChannelID)
		case ch != 0 && row.JoinedAt != token:
			return fmt.Sprintf("%s: client join token %q disagrees with row joined_at %q", m.name, token, row.JoinedAt)
		}
	}
	if u := h.sfu.unhandledRPCs(); len(u) > 0 {
		return fmt.Sprintf("hub called room-service RPCs the fake SFU does not implement: %v", u)
	}
	// SFU view: every participant must belong to a membership the DB names,
	// with the exact join token the identity carries.
	for room, ids := range h.sfu.snapshot() {
		for _, id := range ids {
			uid, token, err := parseParticipantIdentity(id)
			if err != nil {
				return fmt.Sprintf("SFU holds identity %q that does not parse: %v", id, err)
			}
			owner := h.byUserID[uid]
			if owner == nil {
				return fmt.Sprintf("SFU holds participant for unknown user %d in %s", uid, room)
			}
			row := rows[uid]
			if row == nil || RoomName(row.ChannelID) != room {
				return fmt.Sprintf("%s: SFU holds participant %q in %s but its row says %v (ghost participant)", owner.name, id, room, row)
			}
			if row.JoinedAt != token {
				return fmt.Sprintf("%s: SFU participant token %q disagrees with row joined_at %q", owner.name, token, row.JoinedAt)
			}
		}
	}
	// A live, completed membership must have its participant present.
	for _, m := range h.members {
		if m.c == nil {
			continue
		}
		ch, token := m.c.getVoiceState()
		if ch == 0 || !m.c.voiceJoinCompletedForHarness() {
			continue
		}
		if !h.sfu.has(RoomName(ch), participantIdentity(m.userID, token)) {
			return fmt.Sprintf("%s: completed membership in ch%d has no SFU participant %q", m.name, ch, participantIdentity(m.userID, token))
		}
	}
	// A client with no voice state must hold no voice-topic subscription: a
	// socket left subscribed keeps receiving that room's voice_e2ee_announce
	// relays (which carry no channel_id) for the connection's lifetime
	// (OC-0219). Every path that clears voice state while the WS stays up must
	// drop the subscription, so any such path that forgets it shows here.
	for _, m := range h.members {
		if m.c == nil {
			continue
		}
		if ch, _ := m.c.getVoiceState(); ch == 0 {
			for _, other := range h.chanIDs {
				if h.hub.SubscribedToVoiceTopicForTest(m.c, other) {
					return fmt.Sprintf("%s: not in voice but still subscribed to ch%d's voice topic", m.name, other)
				}
			}
		}
	}
	return ""
}

// snapshot returns the fake's participant set keyed by room.
func (f *fakeSFU) snapshot() map[string][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string][]string, len(f.participants))
	for room, ids := range f.participants {
		list := make([]string, 0, len(ids))
		for id := range ids {
			list = append(list, id)
		}
		out[room] = list
	}
	return out
}

// ─── small client helpers for the per-finding scenarios ─────────────────────

// setVoiceStateForHarness sets the client's voice state without marking the
// join complete — the shape of a join that committed its row but is still
// racing its supersession guards (OC-0270), or of a client whose token has
// gone missing (OC-0034).
func (c *Client) setVoiceStateForHarness(chID int64, token string) {
	c.setVoiceState(chID, token)
}

// voiceJoinCompletedForHarness reads voiceJoinCompleted under voiceMu.
func (c *Client) voiceJoinCompletedForHarness() bool {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.voiceJoinCompleted
}

// peekPendingModFlagsForHarness reads the moderator stash without consuming it.
func (c *Client) peekPendingModFlagsForHarness() (serverMuted, serverDeafened bool) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.pendingModServerMuted, c.pendingModServerDeafened
}

// drainHasVoiceLeave reports whether ch holds a voice_leave broadcast for
// (channelID, userID) among its pending frames. The broadcast is delivered by
// the hub loop, so it polls briefly before giving up.
func drainHasVoiceLeave(ch chan []byte, channelID, userID int64) bool {
	deadline := time.Now().Add(2 * time.Second)
	for {
		for {
			select {
			case frame := <-ch:
				var env struct {
					Type    string `json:"type"`
					Payload struct {
						ChannelID int64 `json:"channel_id"`
						UserID    int64 `json:"user_id"`
					} `json:"payload"`
				}
				if json.Unmarshal(frame, &env) == nil &&
					env.Type == MsgTypeVoiceLeaveBC && env.Payload.ChannelID == channelID && env.Payload.UserID == userID {
					return true
				}
				continue
			default:
			}
			break
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// ─── scenarios ──────────────────────────────────────────────────────────────
//
// Each scenario drives one interleaving the eight rollback-class findings
// (OC-0034, 0044, 0219, 0252, 0267, 0270, 0351, 0420) proved was reachable,
// and after every step the three-way oracle runs. The point is not to
// re-assert each finding's specific guarantee (their own tests do that) but to
// keep the central invariant green through the sequences that used to break
// it — so RT-3's reaper and RT-8's grace window extend from a checked base.

// vmJoinSwitchLeave is the baseline journey: two members each join, one
// switches channel, then both leave.
func TestVoiceMembership_JoinSwitchLeave(t *testing.T) {
	h := newVMHarness(t, 2)
	alice, bob := h.members[0], h.members[1]
	chA, chB := h.chanOf("vm-a"), h.chanOf("vm-b")

	h.connect(alice)
	h.connect(bob)
	h.join(alice, chA)
	h.join(bob, chA)
	h.join(alice, chB) // a switch: leave chA, join chB
	h.leave(bob)
	h.leave(alice)
}

// TestVoiceMembership_ModeratorEviction drives a moderator eviction of a
// member in a shared channel; the remaining member stays in place.
func TestVoiceMembership_ModeratorEviction(t *testing.T) {
	h := newVMHarness(t, 2)
	alice, bob := h.members[0], h.members[1]
	chA := h.chanOf("vm-mod")

	h.connect(alice)
	h.connect(bob)
	h.join(alice, chA)
	h.join(bob, chA)
	h.evict(bob)
	h.leave(alice)
}

// TestVoiceMembership_ReconnectTransfer pins OC-0270's sequence: a member in
// voice reconnects, the transfer carries the session to the new socket, and
// the old socket's late teardown must not evict it.
func TestVoiceMembership_ReconnectTransfer(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-reconnect")

	h.connect(alice)
	h.join(alice, chA)
	h.reconnect(alice)
	h.leave(alice)
}

// TestVoiceMembership_DisconnectThenSweep models two sockets dying in voice:
// alice's teardown runs, bob's is missed so his voice_states row lingers; the
// production stale sweep must reap both bob's row and his SFU participant.
func TestVoiceMembership_DisconnectThenSweep(t *testing.T) {
	h := newVMHarness(t, 2)
	alice, bob := h.members[0], h.members[1]
	chA := h.chanOf("vm-sweep")

	h.connect(alice)
	h.connect(bob)
	h.join(alice, chA)
	h.join(bob, chA)
	h.disconnect(alice, true)
	h.disconnect(bob, false)
	// RT-8: alice's completed drop parks in the grace window, so only an
	// expired window leaves her for the sweep to reap; bob's missed teardown
	// has no parked entry at all.
	h.expireGrace(alice)
	h.sweep()
}

// withGraceWindow shrinks the RT-8 grace window for a test and restores it.
func withGraceWindow(t *testing.T, d time.Duration) {
	t.Helper()
	prev := voiceGraceWindow
	voiceGraceWindow = d
	t.Cleanup(func() { voiceGraceWindow = prev })
}

// TestVoiceMembership_GraceWindowReconnect pins RT-8's core: a completed
// membership survives a socket drop inside the grace window, and a resuming
// socket inherits the very same session — token, SFU participant and key —
// with no voice_leave broadcast and no fresh join.
func TestVoiceMembership_GraceWindowReconnect(t *testing.T) {
	withGraceWindow(t, time.Minute) // long enough that only the test expires it
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-reconnect")

	h.connect(alice)
	h.join(alice, chA)
	_, token := alice.c.getVoiceState()
	h.disconnect(alice, true)
	if !h.hub.voiceGrace.has(alice.userID, chA) {
		t.Fatalf("a completed membership was not parked in the grace window")
	}
	// The parked row and SFU participant must still be exactly the join's.
	row, err := h.db.GetVoiceState(context.Background(), alice.userID)
	if err != nil || row == nil || row.ChannelID != chA || row.JoinedAt != token {
		t.Fatalf("grace window changed the membership: row=%v err=%v", row, err)
	}
	if !h.sfu.has(RoomName(chA), participantIdentity(alice.userID, token)) {
		t.Fatalf("grace window removed the SFU participant")
	}

	// A resuming socket inherits the parked session; the harness oracle then
	// requires client, row and SFU to agree, which they now do with no rejoin.
	h.resume(alice)
	if gotCh, gotToken := alice.c.getVoiceState(); gotCh != chA || gotToken != token {
		t.Fatalf("resume inherited %d/%s, want %d/%s", gotCh, gotToken, chA, token)
	}
	if h.hub.voiceGrace.has(alice.userID, chA) {
		t.Fatalf("the parked entry survived inheritance")
	}
	h.leave(alice)
}

// TestVoiceMembership_GraceWindowExpires pins the other half: a window that
// elapses with no resuming socket tears the membership down through the same
// teardown the immediate path used — row, SFU participant and key holder gone.
func TestVoiceMembership_GraceWindowExpires(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-expire")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	h.expireGrace(alice)
	if row, err := h.db.GetVoiceState(context.Background(), alice.userID); err != nil || row != nil {
		t.Fatalf("expired grace window left a row: row=%v err=%v", row, err)
	}
	if h.hub.IsVoiceKeyHolder(chA, alice.userID) {
		t.Fatalf("expired grace window left a phantom key holder")
	}
}

// TestVoiceMembership_GraceWindowSweepSkipsParked pins that the stale sweep
// does not reap a parked membership: the row has no live client during the
// window, which is exactly the ghost shape the sweep exists to remove.
func TestVoiceMembership_GraceWindowSweepSkipsParked(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-sweep")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	h.sweep() // must NOT reap the parked row
	if row, err := h.db.GetVoiceState(context.Background(), alice.userID); err != nil || row == nil {
		t.Fatalf("sweep reaped a parked membership: row=%v err=%v", row, err)
	}
	h.resume(alice) // and a resume still inherits it
	h.leave(alice)
}

// TestVoiceMembership_GraceWindowIncompleteJoinsNotParked pins OC-0270's
// boundary: only a COMPLETED join is parked. A join that committed its row but
// never completed has no delivered membership to preserve, so the drop tears
// it down at once rather than holding a half-session.
func TestVoiceMembership_GraceWindowIncompleteJoinsNotParked(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-incomplete")

	h.connect(alice)
	if err := h.db.JoinVoiceChannel(context.Background(), alice.userID, chA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	row, _ := h.db.GetVoiceState(context.Background(), alice.userID)
	alice.c.setVoiceStateForHarness(chA, row.JoinedAt) // committed, not completed
	h.disconnect(alice, true)
	if h.hub.voiceGrace.has(alice.userID, chA) {
		t.Fatalf("an incomplete join was parked in the grace window")
	}
	if row, err := h.db.GetVoiceState(context.Background(), alice.userID); err != nil || row != nil {
		t.Fatalf("incomplete join left a row after drop: row=%v err=%v", row, err)
	}
}

// TestVoiceMembership_GraceWindowResumeReelectsKeyHolder pins that a grace
// resume restores the lowest-uid key holder: an election held while the
// member was parked could not see them, and every client assumes the holder
// is the lowest uid in the room.
func TestVoiceMembership_GraceWindowResumeReelectsKeyHolder(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 3)
	alice, bob, carol := h.members[0], h.members[1], h.members[2]
	chA := h.chanOf("vm-grace-keyholder")
	for _, m := range h.members {
		h.connect(m)
		h.join(m, chA)
	}

	h.disconnect(alice, true)
	h.leave(carol) // an election inside the window, without alice
	if !h.hub.IsVoiceKeyHolder(chA, bob.userID) {
		t.Fatalf("precondition: the in-window election did not pick bob")
	}
	h.resume(alice)
	if !h.hub.IsVoiceKeyHolder(chA, alice.userID) {
		t.Fatalf("a grace resume did not restore the lowest-uid key holder")
	}
}

// TestVoiceMembership_GraceWindowHandshakeFailure pins the failed-handshake
// teardown: a resume that inherited a parked call and then fails its
// handshake write parks the call again for the next redial, while a session
// revoked during the handshake ends it at once.
func TestVoiceMembership_GraceWindowHandshakeFailure(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-handshake")
	ctx := context.Background()

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	h.resume(alice)

	h.hub.unregisterFailedHandshake(ctx, alice.c)
	alice.c = nil
	h.check()
	if !h.hub.voiceGrace.has(alice.userID, chA) {
		t.Fatalf("a failed resume handshake did not park the inherited call")
	}

	h.resume(alice)
	if ch := alice.c.getVoiceChID(); ch != chA {
		t.Fatalf("the redial after a failed handshake inherited ch%d, want ch%d", ch, chA)
	}
	alice.c.tokenHash = "revoked-during-handshake"
	if !h.hub.postRegisterSessionRecheck(ctx, alice.c) {
		t.Fatalf("precondition: the session recheck did not see the revoked session")
	}
	alice.c = nil
	h.check()
	if h.hub.voiceGrace.has(alice.userID, chA) {
		t.Fatalf("a session revoked during the handshake parked the call")
	}
	if row, err := h.db.GetVoiceState(ctx, alice.userID); err != nil || row != nil {
		t.Fatalf("a session revoked during the handshake left a row: row=%v err=%v", row, err)
	}
}

// TestVoiceMembership_GraceWindowConcurrentEvictNotParked pins that a
// teardown finding the membership already cleared by a concurrent eviction
// parks nothing, so no expiry re-runs a leave that already happened.
func TestVoiceMembership_GraceWindowConcurrentEvictNotParked(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-evict-race")
	ctx := context.Background()

	h.connect(alice)
	h.join(alice, chA)
	c := alice.c
	h.hub.unregisterNow(c)
	if !h.hub.handleVoiceLeaveIfStillIn(ctx, c, chA, voiceLeaveReasonModerator) {
		t.Fatalf("precondition: the eviction did not clear the membership")
	}
	h.hub.leaveVoiceOnDisconnect(ctx, c, voiceLeaveReasonDisconnect)
	alice.c = nil
	h.check()
	if h.hub.voiceGrace.get(alice.userID) != nil {
		t.Fatalf("a membership already evicted was parked")
	}
}

// TestVoiceMembership_GraceWindowTerminalKickEjects pins that a kick which
// refuses reconnection — a ban or a force-logout — ends the call at once
// rather than parking it, whether the member is still connected or already
// parked, while an ordinary drop still parks.
func TestVoiceMembership_GraceWindowTerminalKickEjects(t *testing.T) {
	for name, kick := range map[string]func(*Hub, int64){
		"ban":          (*Hub).DisconnectUser,
		"force-logout": (*Hub).DisconnectRevokedUser,
	} {
		t.Run(name, func(t *testing.T) {
			withGraceWindow(t, time.Minute)
			h := newVMHarness(t, 3)
			alice, bob, carol := h.members[0], h.members[1], h.members[2]
			chA := h.chanOf("vm-grace-terminal-" + name)
			for _, m := range h.members {
				h.connect(m)
				h.join(m, chA)
			}

			kick(h.hub, alice.userID)
			h.disconnect(alice, true) // the kicked socket's read-loop teardown
			h.disconnect(bob, true)   // an ordinary drop
			kick(h.hub, bob.userID)   // then the kick lands on the parked member
			h.disconnect(carol, true) // an ordinary drop that nobody kicks
			h.check()

			for _, m := range []*vmMember{alice, bob} {
				if h.hub.voiceGrace.has(m.userID, chA) {
					t.Fatalf("%s: a terminal kick parked the membership", m.name)
				}
				if row, err := h.db.GetVoiceState(context.Background(), m.userID); err != nil || row != nil {
					t.Fatalf("%s: a terminal kick left a row: row=%v err=%v", m.name, row, err)
				}
			}
			if !h.hub.voiceGrace.has(carol.userID, chA) {
				t.Fatalf("an ordinary drop was not parked")
			}
		})
	}
}

// TestVoiceMembership_GraceWindowModeratorKickWhileParked pins that a
// moderator kick reaches a parked member: the eviction reports success, tears
// the membership down, and a later resume inherits nothing.
func TestVoiceMembership_GraceWindowModeratorKickWhileParked(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-modkick")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	if !h.hub.DisconnectFromVoiceInChannel(context.Background(), alice.userID, chA, voiceLeaveReasonModerator) {
		t.Fatalf("moderator kick missed a parked member")
	}
	h.check()
	if row, err := h.db.GetVoiceState(context.Background(), alice.userID); err != nil || row != nil {
		t.Fatalf("moderator kick left a parked row: row=%v err=%v", row, err)
	}
	h.resume(alice)
	if ch := alice.c.getVoiceChID(); ch != 0 {
		t.Fatalf("resume after a moderator kick inherited ch%d", ch)
	}
}

// TestVoiceMembership_GraceWindowRelaunchWithinWindow pins the relaunch
// sequence: the app quits in voice (the SFU's participant_left deletes the
// row), relaunches inside the window and rejoins. No parked window may
// survive to tear the new call down.
func TestVoiceMembership_GraceWindowRelaunchWithinWindow(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-relaunch")

	h.connect(alice)
	h.join(alice, chA)
	_, token := alice.c.getVoiceState()
	h.disconnect(alice, true)
	h.sfu.remove(RoomName(chA), participantIdentity(alice.userID, token))
	h.hub.HandleWebhookParticipantLeftWithContextForTest(context.Background(), alice.userID, chA, token)
	if h.hub.voiceGrace.has(alice.userID, chA) {
		t.Fatalf("participant_left kept a parked window over a deleted row")
	}
	h.check()

	h.connect(alice)
	if !h.join(alice, chA) {
		t.Fatalf("rejoin after relaunch did not complete")
	}
	if h.hub.voiceGrace.get(alice.userID) != nil {
		t.Fatalf("a parked window survived the relaunch")
	}
	h.leave(alice)
}

// TestVoiceMembership_GraceWindowFreshConnectCancels pins that a fresh
// connect (lastSeq 0) ends a parked window even when nothing else did, so its
// timer can never later broadcast a voice_leave over the new session.
func TestVoiceMembership_GraceWindowFreshConnectCancels(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-fresh")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	h.connect(alice)
	if h.hub.voiceGrace.get(alice.userID) != nil {
		t.Fatalf("a fresh connect left the parked window running")
	}
}

// TestVoiceMembership_GraceWindowResumeNeedsRow pins that a resume inherits a
// parked membership only while its row still exists: inheriting one whose row
// is gone is the memory-without-row ghost no sweep can heal.
func TestVoiceMembership_GraceWindowResumeNeedsRow(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-grace-resume-row")

	h.connect(alice)
	h.join(alice, chA)
	_, token := alice.c.getVoiceState()
	h.disconnect(alice, true)
	h.sfu.remove(RoomName(chA), participantIdentity(alice.userID, token))
	if _, err := h.db.LeaveVoiceChannelIfMatch(context.Background(), alice.userID, chA, token); err != nil {
		t.Fatalf("LeaveVoiceChannelIfMatch: %v", err)
	}
	h.resume(alice)
	if ch := alice.c.getVoiceChID(); ch != 0 {
		t.Fatalf("resume inherited ch%d whose row is gone", ch)
	}
}

// TestVoiceMembership_RollbackLeavesNoGhost pins OC-0044/OC-0219/OC-0267's
// sequence: a join that is rolled back mid-flight must leave neither a row, a
// subscription, nor an SFU participant behind.
func TestVoiceMembership_RollbackLeavesNoGhost(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-rollback")

	h.connect(alice)
	// A join that completed, then a rollback of that exact session — the shape
	// the rollback paths unwind (a failed join after the row committed).
	h.join(alice, chA)
	h.rollback(alice, chA)
	h.sweep()
}

// TestVoiceMembership_Acceptance drives one sequence per rollback-class
// finding so that reverting the finding's fix turns this harness red:
//
//	OC-0034  aborted switch leaves the client cleared, then the sweep reaps
//	         the leftover row
//	OC-0044  a stale join's rollback leaves a newer membership intact
//	OC-0219  a rollback leaves no voice-topic subscription behind
//	OC-0252  a fresh connect clears the old client's in-memory state + key holder
//	OC-0267  a rollback's voice_leave reaches the leaver itself
//	OC-0270  a reconnect does not transfer an incomplete join
//	OC-0351  a switch to a full channel keeps the caller's current call
//	OC-0420  a failed re-join keeps the moderator's mute stash
func TestVoiceMembership_Acceptance(t *testing.T) {
	cases := []struct {
		name string
		run  func(t *testing.T, h *vmHarness, members []*vmMember, chans []int64)
	}{
		{"oc0034-aborted-switch", func(t *testing.T, h *vmHarness, m []*vmMember, ch []int64) {
			h.connect(m[0])
			h.join(m[0], ch[0])
			h.abortedSwitch(m[0], ch[0], ch[1])
		}},
		{"oc0044-stale-rollback", func(t *testing.T, h *vmHarness, m []*vmMember, ch []int64) {
			h.connect(m[0])
			h.staleRollback(m[0], ch[0], ch[1])
		}},
		{"oc0219-rollback-unsubscribes", func(t *testing.T, h *vmHarness, m []*vmMember, ch []int64) {
			h.connect(m[0])
			h.join(m[0], ch[0])
			h.rollback(m[0], ch[0])
		}},
		{"oc0252-fresh-connect-clears-old-client", func(t *testing.T, h *vmHarness, m []*vmMember, ch []int64) {
			h.connect(m[0])
			h.join(m[0], ch[0])
			h.freshConnect(m[0])
		}},
		{"oc0267-rollback-reaches-leaver", func(t *testing.T, h *vmHarness, m []*vmMember, ch []int64) {
			h.connect(m[0])
			h.denyRead(ch[0])
			h.join(m[0], ch[0])
			h.rollback(m[0], ch[0])
		}},
		{"oc0270-reconnect-incomplete", func(t *testing.T, h *vmHarness, m []*vmMember, ch []int64) {
			h.connect(m[0])
			if err := h.db.JoinVoiceChannel(context.Background(), m[0].userID, ch[0]); err != nil {
				t.Fatalf("JoinVoiceChannel: %v", err)
			}
			h.reconnectIncomplete(m[0], ch[0])
		}},
		{"oc0351-switch-to-full-keeps-old-call", func(t *testing.T, h *vmHarness, m []*vmMember, ch []int64) {
			h.connect(m[0])
			h.connect(m[1])
			h.join(m[0], ch[0])
			h.join(m[1], ch[2])
			// m[1]'s channel is capped at 1; m[0]'s switch must be refused and
			// her ch[0] membership preserved.
			beforeCh, beforeToken := m[0].c.getVoiceState()
			if h.join(m[0], ch[2]) {
				t.Fatal("join to a full channel unexpectedly completed")
			}
			if ch, token := m[0].c.getVoiceState(); ch != beforeCh || token != beforeToken {
				t.Fatalf("refused switch changed membership from %d/%s to %d/%s (OC-0351)", beforeCh, beforeToken, ch, token)
			}
		}},
		{"oc0420-failed-join-keeps-stash", func(t *testing.T, h *vmHarness, m []*vmMember, ch []int64) {
			h.connect(m[0])
			h.connect(m[1])
			h.join(m[1], ch[2]) // fill the capped channel
			h.stashSurvivesJoinFailure(m[0], ch[2])
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newVMHarness(t, 2)
			ch0, ch1 := h.chanOf("vm-a"), h.chanOf("vm-b")
			// A destination capped at one slot, for OC-0351 and OC-0420.
			full, err := h.db.CreateChannel(context.Background(), "vm-full", "voice", "", "", 0)
			if err != nil {
				t.Fatalf("CreateChannel: %v", err)
			}
			if _, err := h.db.ExecContext(context.Background(), `UPDATE channels SET voice_max_users = 1 WHERE id = ?`, full); err != nil {
				t.Fatalf("set voice_max_users: %v", err)
			}
			h.chanIDs = append(h.chanIDs, full)
			tc.run(t, h, h.members, []int64{ch0, ch1, full})
		})
	}
}
