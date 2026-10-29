package ws

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// modID creates an Owner-role moderator, who outranks every test target.
func modID(t *testing.T, database *db.DB) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), "timeout-stay-mod", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser mod: %v", err)
	}
	return id
}

// A member already in voice who is timed out keeps their seat: the stale-voice
// sweep and the token refresh evict only for a reason that would refuse the
// session on its own, never for the timeout (whose voice half is a
// server-mute, applied by the moderator's own authority). A member who lost
// CONNECT_VOICE is still evicted, timed out or not.
func TestTimeout_InVoiceMemberSurvivesSweepAndTokenRefresh(t *testing.T) {
	ctx := context.Background()
	deps, database := tokenRefreshDeps(t)
	h := newTestHubWith(t, HubOptions{DB: database})
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	c := NewTestClient(h, 1, make(chan []byte, 8))
	c.voice.setState(100, state.JoinedAt)
	h.clients[1] = []*Client{c}

	if _, _, err := database.TimeoutUser(ctx, 1, modID(t, database), nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}

	h.sweepStaleVoiceEvictRevoked(ctx)
	if c.voice.channel() != 100 {
		t.Fatal("the sweep evicted a timed-out member whose permissions are intact")
	}

	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: state.JoinedAt}
	res := handleVoiceTokenRefreshV2(ctx, VoiceTokenRefreshCmd{userID: 1}, info, deps)
	if res.Error != nil || res.LeaveVoice {
		t.Fatalf("token refresh for a timed-out member in voice = error %v, leave %v; want a fresh token", res.Error, res.LeaveVoice)
	}

	// The timeout is no shield: a revoked CONNECT_VOICE still evicts.
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages)
	deps.Limiter = auth.NewRateLimiter() // the first refresh spent this window
	res = handleVoiceTokenRefreshV2(ctx, VoiceTokenRefreshCmd{userID: 1}, info, deps)
	if res.Error == nil || !res.LeaveVoice {
		t.Fatal("token refresh must still evict a member who lost CONNECT_VOICE")
	}
	h.sweepStaleVoiceEvictRevoked(ctx)
	if c.voice.channel() != 0 {
		t.Fatal("the sweep must still evict a member who lost CONNECT_VOICE")
	}
}

// A refresh for a server-muted timed-out member must not hand back publish
// rights: the persisted mute still shapes the token.
func TestTimeout_TokenRefreshKeepsTimeoutMute(t *testing.T) {
	ctx := context.Background()
	deps, database := tokenRefreshDeps(t)
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice)
	h := newTestHubWith(t, HubOptions{DB: database})
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	id, _, err := database.TimeoutUser(ctx, 1, modID(t, database), nil, "cool off", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	prev := muteParticipantHookForTest
	muteParticipantHookForTest = func(context.Context, int64, int64, string, bool) error { return nil }
	defer func() { muteParticipantHookForTest = prev }()
	if applied, owned := h.MuteForTimeout(ctx, 1, 100, id, state.JoinedAt, nil); !applied || !owned {
		t.Fatalf("MuteForTimeout applied=%v owned=%v", applied, owned)
	}

	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: state.JoinedAt}
	res := handleVoiceTokenRefreshV2(ctx, VoiceTokenRefreshCmd{userID: 1}, info, deps)
	if res.Error != nil || res.LeaveVoice {
		t.Fatalf("refresh = error %v, leave %v", res.Error, res.LeaveVoice)
	}
	if now, _ := h.voice.State(ctx, 1); now == nil || !now.ServerMuted {
		t.Fatal("the refresh must leave the timeout's server-mute in place")
	}
	muted, _ := h.voice.State(ctx, 1)
	if voiceMicrophoneAllowed(true, muted) {
		t.Fatal("a server-muted member must not regain microphone publish")
	}
}

// When a timeout runs out on its own, its voice server-mute lifts at once —
// not at the next 15-minute maintenance tick — while a mute a moderator
// applied separately (no owning action) stays.
func TestTimeoutExpiry_TimerLiftsTimeoutMuteButNotManualMute(t *testing.T) {
	ctx := context.Background()
	database, chID := applyTimeoutMuteTestDB(t)
	timedOut, err := database.CreateUser(ctx, "expiry-timed-out", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	manual, err := database.CreateUser(ctx, "expiry-manual", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	h := newTestHubWith(t, HubOptions{DB: database})
	prev := muteParticipantHookForTest
	muteParticipantHookForTest = func(context.Context, int64, int64, string, bool) error { return nil }
	defer func() { muteParticipantHookForTest = prev }()

	for _, uid := range []int64{timedOut, manual} {
		if err := h.voice.Join(ctx, uid, chID, 0); err != nil {
			t.Fatalf("Join %d: %v", uid, err)
		}
	}
	expires := time.Now().Add(2 * time.Second)
	id, _, err := database.TimeoutUser(ctx, timedOut, modID(t, database), nil, "brief", expires)
	if err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	st, _ := h.voice.State(ctx, timedOut)
	if applied, owned := h.MuteForTimeout(ctx, timedOut, chID, id, st.JoinedAt, nil); !applied || !owned {
		t.Fatalf("MuteForTimeout applied=%v owned=%v", applied, owned)
	}
	if matched, _, err := h.SetServerMuteLocked(ctx, manual, chID, true); err != nil || !matched {
		t.Fatalf("manual mute: matched=%v err=%v", matched, err)
	}
	// The manually muted user's timer fires first (two seconds before the
	// timed-out user's), so by the time the timeout's mute has lifted the
	// manual user's callback has provably run and found nothing of a
	// timeout's to lift.
	h.scheduleTimeoutExpiryRefresh(manual, time.Now())
	h.scheduleTimeoutExpiryRefresh(timedOut, expires)

	deadline := time.Now().Add(8 * time.Second)
	for {
		s, _ := h.voice.State(ctx, timedOut)
		if s != nil && !s.ServerMuted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the expiry timer did not lift the timeout's voice mute")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if s, _ := h.voice.State(ctx, manual); s == nil || !s.ServerMuted {
		t.Fatal("the expiry timer lifted a mute a moderator applied separately")
	}
}

// A timeout that is superseded keeps the mute: when the older timeout's timer
// fires, ownership has moved to the newer one, which is still active, so the
// mute stays; it lifts only when the newer timeout runs out.
func TestTimeoutExpiry_SupersededTimerKeepsMuteUntilNewTimeoutEnds(t *testing.T) {
	ctx := context.Background()
	database, chID := applyTimeoutMuteTestDB(t)
	uid, err := database.CreateUser(ctx, "expiry-superseded", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	h := newTestHubWith(t, HubOptions{DB: database})
	prev := muteParticipantHookForTest
	muteParticipantHookForTest = func(context.Context, int64, int64, string, bool) error { return nil }
	defer func() { muteParticipantHookForTest = prev }()
	if err := h.voice.Join(ctx, uid, chID, 0); err != nil {
		t.Fatalf("Join: %v", err)
	}
	st, _ := h.voice.State(ctx, uid)
	mod := modID(t, database)

	// expires_at is stored to the whole second, so a plain time.Now()+1s can
	// already read as expired by the time MuteForTimeout checks it if the
	// test starts late in a second. Anchoring on a whole second keeps A at
	// least a second ahead of now, and B well past A's timer.
	base := time.Now().Truncate(time.Second)
	expiresA := base.Add(2 * time.Second)
	idA, _, err := database.TimeoutUser(ctx, uid, mod, nil, "first", expiresA)
	if err != nil {
		t.Fatalf("TimeoutUser A: %v", err)
	}
	if applied, owned := h.MuteForTimeout(ctx, uid, chID, idA, st.JoinedAt, nil); !applied || !owned {
		t.Fatalf("MuteForTimeout A applied=%v owned=%v", applied, owned)
	}
	h.scheduleTimeoutExpiryRefresh(uid, expiresA)

	// B supersedes A before A's timer fires; ownership moves A -> B.
	expiresB := base.Add(5 * time.Second)
	idB, superseded, err := database.TimeoutUser(ctx, uid, mod, nil, "second", expiresB)
	if err != nil {
		t.Fatalf("TimeoutUser B: %v", err)
	}
	h.MuteForTimeout(ctx, uid, chID, idB, st.JoinedAt, superseded)
	if s, _ := h.voice.State(ctx, uid); s == nil || s.ServerMutedBy == nil || *s.ServerMutedBy != idB {
		t.Fatalf("ownership did not move to B (%d): %+v", idB, s)
	}
	h.scheduleTimeoutExpiryRefresh(uid, expiresB)

	// Past A's timer (expiresA + 1s slack), B is still active.
	time.Sleep(time.Until(expiresA) + timeoutExpiryRefreshSlack + 500*time.Millisecond)
	if s, _ := h.voice.State(ctx, uid); s == nil || !s.ServerMuted || s.ServerMutedBy == nil || *s.ServerMutedBy != idB {
		t.Fatalf("A's timer lifted or disturbed B's mute: %+v", s)
	}

	deadline := expiresB.Add(timeoutExpiryRefreshSlack + 3*time.Second)
	for {
		if s, _ := h.voice.State(ctx, uid); s != nil && !s.ServerMuted {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("B's expiry did not lift the mute")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
