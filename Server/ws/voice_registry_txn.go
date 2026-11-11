package ws

// Every voice membership write goes through a lock handle: Hub.begin takes a user's
// voiceMember lock and returns a *voiceTxn, the compile-time proof a path owns it. These
// methods are the only code that changes the slot's channel/token/completed flag/E2EE key,
// deletes a voice_states row, or touches a membership's VoiceTopic subscription (pinned by
// the invariants package, voice-membership-writes). Lock order and what may run under the
// lock: voice_registry.go. Flag rows, broadcasts, key-holder election, permission checks and
// SFU RPCs stay with callers.

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// errVoiceJoinReadBack marks a persistJoin whose row committed but could not be read back; the caller rolls
// back.
var errVoiceJoinReadBack = errors.New("voice join: read back the committed row")

type voiceTxn struct {
	h      *Hub
	userID int64
	unlock func() // nil once end has run, and for Hub.heldTxn
}

// begin takes userID's voice membership lock and returns the handle. Release with end
// (normally deferred). Callers hold none of the locks to the right of voiceMember.
func (h *Hub) begin(userID int64) *voiceTxn {
	return &voiceTxn{h: h, userID: userID, unlock: h.voiceHub.reg.voiceMember.Lock(userID)}
}

// heldTxn returns a lock-free handle. Its one production caller is onClientEvent: the hub
// dispatch goroutine must never take the voice member lock. VoiceMutatorAllow lists the one call.
func (h *Hub) heldTxn(userID int64) *voiceTxn {
	return &voiceTxn{h: h, userID: userID}
}

func (t *voiceTxn) end() {
	if t.unlock == nil {
		return
	}
	unlock := t.unlock
	t.unlock = nil
	unlock()
}

// persistJoin inserts the voice_states row under capacity, reads it back, then publishes the
// slot's membership (before the permission checks and token mint that follow). A full
// channel wraps service.ErrVoiceChannelFull; an unreadable row returns errVoiceJoinReadBack
// and leaves the slot untouched.
func (t *voiceTxn) persistJoin(ctx context.Context, c *Client, chID int64, capacity int) (*db.VoiceState, error) {
	if err := t.h.voice.Join(ctx, t.userID, chID, capacity); err != nil {
		return nil, fmt.Errorf("persist voice join: %w", err)
	}

	// Load the row now so later cleanup targets this exact join instance.
	state, err := t.h.voice.State(ctx, t.userID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errVoiceJoinReadBack, err)
	}
	if state == nil {
		return nil, fmt.Errorf("%w: no row", errVoiceJoinReadBack)
	}

	// The stale-voice sweep snapshots clients without the voice lock, but its delete runs under
	// the lock and rechecks. A failure below unwinds via rollbackVoiceJoin.
	if voiceJoinPostCommitRaceHook != nil {
		voiceJoinPostCommitRaceHook(c)
	}
	c.voice.setState(chID, state.JoinedAt)
	return state, nil
}

// markCompleted records that the join for (chID, token) passed voiceJoinComplete's
// supersession guard and only then subscribes c to VoiceTopic(chID), in one slot critical
// section; false (nothing subscribed) means the slot moved on.
func (t *voiceTxn) markCompleted(c *Client, chID int64, token string) bool {
	if !c.voice.markCompletedIfMatch(chID, token) {
		return false
	}
	t.h.pubsub.Subscribe(c, VoiceTopic(chID))
	return true
}

// clear empties c's slot and drops its VoiceTopic subscription, returning what was cleared.
// Clearing without unsubscribing would leave the socket receiving that room's
// voice_e2ee_announce relays for the connection's lifetime.
func (t *voiceTxn) clear(c *Client) slotSnap {
	snap := c.voice.clearSnap()
	if snap.chID != 0 {
		t.h.pubsub.Unsubscribe(c, VoiceTopic(snap.chID))
	}
	return snap
}

// clearIfChannel is clear conditioned on the slot still naming chID, so a membership
// committed after a snapshot survives a delayed eviction.
func (t *voiceTxn) clearIfChannel(c *Client, chID int64) (slotSnap, bool) {
	snap, ok := c.voice.clearSnapIfChannel(chID)
	if !ok {
		return slotSnap{}, false
	}
	t.h.pubsub.Unsubscribe(c, VoiceTopic(chID))
	return snap, true
}

// clearExact is clear conditioned on this exact join instance (channel and token): a
// same-channel rejoin has a new token and survives, an empty token never matches. It resets
// the completed flag too, or a later reconnect could get completed=true with channel 0.
func (t *voiceTxn) clearExact(c *Client, chID int64, token string) bool {
	if token == "" {
		return false
	}
	if !c.voice.clearExact(chID, token) {
		return false
	}
	t.h.pubsub.Unsubscribe(c, VoiceTopic(chID))
	return true
}

// deleteRow removes the voice_states row for the join instance (chID, joinedAt). It drops
// the matching grace entry first, so a failed delete leaves the row for the stale sweep with
// no grace timer to tear it down twice. Instance-scoped, so leaveVoiceChannelWithRetry may
// run it after the lock is released.
func (t *voiceTxn) deleteRow(ctx context.Context, chID int64, joinedAt string) (bool, error) {
	return t.h.voiceHub.reg.deleteJoinRow(ctx, t.h, t.userID, chID, joinedAt)
}

// deleteJoinRow is deleteRow without the handle. Safe without the member lock because the
// delete is scoped to one join instance, so a late run cannot touch a newer join.
func (r *voiceRegistry) deleteJoinRow(ctx context.Context, h *Hub, userID, chID int64, joinedAt string) (bool, error) {
	r.voiceGrace.takeJoin(userID, chID, joinedAt)
	if h.voice == nil {
		return false, nil
	}
	deleted, err := h.voice.LeaveIfMatch(ctx, userID, chID, joinedAt)
	if err != nil {
		return false, fmt.Errorf("delete voice row: %w", err)
	}
	return deleted, nil
}

// takeParked removes and returns userID's grace entry (or nil) and stops its timer. Zero
// chID matches any entry. Taking under the member lock keeps a resuming socket's inherit and
// the expiry teardown from both running.
func (t *voiceTxn) takeParked(chID int64) *voiceGraceEntry {
	return t.h.voiceHub.reg.voiceGrace.takeJoin(t.userID, chID, "")
}

// takeParkedOfSession is takeParked limited to tokenHash's session: a reloading device discards only its own
// parked call.
func (t *voiceTxn) takeParkedOfSession(tokenHash string) *voiceGraceEntry {
	g := &t.h.voiceHub.reg.voiceGrace
	if e := g.get(t.userID); e == nil || e.client.tokenHash != tokenHash {
		return nil
	}
	return g.take(t.userID)
}

// dropParked drops userID's grace entry for chID whatever its join token, for a channel torn down under every
// member.
func (t *voiceTxn) dropParked(chID int64) {
	t.takeParked(chID)
}

// transfer hands old's slot to c when a new connection replaces it and returns the voice
// channel old was in (0 for none) so the caller can re-run key-holder election. In one
// critical section: the moderator's pending mute/deafen always moves (it lives only on the
// client between a move's eviction and the re-join); the membership (channel, token,
// completed flag, E2EE key) moves only when resume is true, c is not in a channel and old's
// join had completed. A join still racing its supersession guards would read the move as an
// eviction and abandon itself with its row left behind, so an incomplete one stays with old
// and is cleared (the sweep reaps its row). The caller strips old's subscriptions and
// subscribes c. TestVoiceRegistry_TransferCarriesEveryField fails when a voiceSlot field is
// neither moved nor reset here.
func (t *voiceTxn) transfer(old, c *Client, resume bool) int64 {
	snap, flags := old.voice.drainAll()
	if flags.muted || flags.deafened {
		c.voice.stashModFlags(flags.muted, flags.deafened, flags.mutedBy)
	}
	if resume && snap.completed {
		c.voice.adopt(snap)
	}
	return snap.chID
}

// stashModFlags stashes a moderator mute/deafen on c, replacing any earlier stash. A
// moderator move runs it in the same txn as the eviction, so the target's own channel switch
// cannot take the stash in between.
func (t *voiceTxn) stashModFlags(c *Client, serverMuted, serverDeafened bool, serverMutedBy *int64) {
	c.voice.stashModFlags(serverMuted, serverDeafened, serverMutedBy)
}

// adoptParked installs a parked grace snapshot as c's membership; false when c is already in a channel.
func (t *voiceTxn) adoptParked(c *Client, snap slotSnap) bool {
	return c.voice.adopt(snap)
}

// setJoinToken adopts tok as c's join token (token refresh, when the client had none). Only
// while c is in voice with an empty token; a cached token is never overwritten.
func (t *voiceTxn) setJoinToken(c *Client, tok string) {
	c.voice.adoptJoinToken(tok)
}
