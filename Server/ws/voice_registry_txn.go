package ws

// Every voice membership write goes through a lock handle. Hub.begin takes a user's
// voice membership lock (voiceMember) and returns a *voiceTxn; holding one is the
// compile-time proof that a path owns the lock. The methods below are the only code
// that changes the slot's channel/token/completed flag/E2EE key, deletes a
// voice_states row, or touches the VoiceTopic subscription of a membership. The
// invariants package pins that boundary (voice-membership-writes): slot field writes,
// VoiceStore.Join and VoiceStore.LeaveIfMatch may only appear in voice_registry*.go.
// Lock order and the rules for what may run under the lock are in voice_registry.go.
// Self and moderator flag rows, broadcasts, key-holder election, permission checks
// and SFU RPCs stay with callers.

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// errVoiceJoinReadBack marks a persistJoin whose row committed but could not be read
// back; the caller rolls the half-made join back.
var errVoiceJoinReadBack = errors.New("voice join: read back the committed row")

// voiceTxn is a handle on one user's voice membership lock.
type voiceTxn struct {
	h      *Hub
	userID int64
	unlock func() // nil once end has run, and for Hub.heldTxn
}

// begin takes userID's voice membership lock and returns the handle that proves it.
// Release with end, normally `defer txn.end()`. Callers hold none of the locks to
// the right of voiceMember in the order (voice_registry.go).
func (h *Hub) begin(userID int64) *voiceTxn {
	return &voiceTxn{h: h, userID: userID, unlock: h.voiceReg.voiceMember.lock(userID)}
}

// heldTxn returns a lock-free handle. Its one production caller is onClientEvent:
// the hub dispatch goroutine must never take the voice member lock, and the
// test-only Register event it applies has no concurrent voice path to exclude.
// serve_pumps_reconnect_race_test.go also borrows it to model an interleaving the
// member lock now forbids, keeping the shouldMarkOffline re-check pinned. Every other
// path passes begin's handle. VoiceMutatorAllow lists the one call.
func (h *Hub) heldTxn(userID int64) *voiceTxn {
	return &voiceTxn{h: h, userID: userID}
}

// end releases the lock; calling it again, or on a lock-free handle, does nothing.
func (t *voiceTxn) end() {
	if t.unlock == nil {
		return
	}
	unlock := t.unlock
	t.unlock = nil
	unlock()
}

// persistJoin inserts the voice_states row under capacity, reads the committed row
// back, then publishes the slot's membership, in this order: the slot is set as
// soon as the row is confirmed, before the permission checks and token mint that
// follow. A full channel returns an error wrapping service.ErrVoiceChannelFull. A
// row that cannot be read back returns errVoiceJoinReadBack and leaves the slot
// untouched.
func (t *voiceTxn) persistJoin(ctx context.Context, c *Client, chID int64, capacity int) (*db.VoiceState, error) {
	if err := t.h.voice.Join(ctx, t.userID, chID, capacity); err != nil {
		return nil, fmt.Errorf("persist voice join: %w", err)
	}

	// Load the persisted row immediately so later cleanup can target this exact join
	// instance even if the user rejoins the same channel.
	state, err := t.h.voice.State(ctx, t.userID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errVoiceJoinReadBack, err)
	}
	if state == nil {
		return nil, fmt.Errorf("%w: no row", errVoiceJoinReadBack)
	}

	// The stale-voice sweep snapshots clients without the voice lock, so it can still
	// see 0 here, but its delete runs under the lock and rechecks first. A failure
	// below unwinds via rollbackVoiceJoin.
	if voiceJoinPostCommitRaceHook != nil {
		voiceJoinPostCommitRaceHook(c)
	}
	c.voice.setState(chID, state.JoinedAt)
	return state, nil
}

// markCompleted records that the join for (chID, token) passed voiceJoinComplete's
// supersession guard and only then subscribes c to VoiceTopic(chID). The compare and
// flag are one slot critical section; false (nothing subscribed) means the slot
// moved on. Every clear below unsubscribes, so the pairing cannot be forgotten.
func (t *voiceTxn) markCompleted(c *Client, chID int64, token string) bool {
	if !c.voice.markCompletedIfMatch(chID, token) {
		return false
	}
	t.h.pubsub.Subscribe(c, VoiceTopic(chID))
	return true
}

// clear empties c's slot (channel, token, completed flag, E2EE key) and drops its
// VoiceTopic subscription, returning what was cleared. Every path taking a client
// out of voice while its WS stays up needs the pair: clearing without unsubscribing
// leaves the socket receiving that room's voice_e2ee_announce relays (no channel_id
// to filter on) for the connection's lifetime.
func (t *voiceTxn) clear(c *Client) slotSnap {
	snap := c.voice.clearSnap()
	if snap.chID != 0 {
		t.h.pubsub.Unsubscribe(c, VoiceTopic(snap.chID))
	}
	return snap
}

// clearIfChannel is clear conditioned on the slot still naming chID, reporting
// whether it cleared, so a membership committed after a snapshot survives a delayed
// eviction.
func (t *voiceTxn) clearIfChannel(c *Client, chID int64) (slotSnap, bool) {
	snap, ok := c.voice.clearSnapIfChannel(chID)
	if !ok {
		return slotSnap{}, false
	}
	t.h.pubsub.Unsubscribe(c, VoiceTopic(chID))
	return snap, true
}

// clearExact is clear conditioned on the slot still naming this exact join instance
// (channel and token). A same-channel rejoin has a new token and survives; an empty
// token never matches. It resets the completed flag too, or a later reconnect could
// hand a new socket completed=true with channel 0.
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

// deleteRow removes the voice_states row for the join instance (chID, joinedAt),
// reporting whether a row was deleted. It drops the matching grace entry first, so a
// failed delete leaves the row for the stale sweep with no grace timer to tear it
// down twice. With no VoiceStore it only drops the entry. The delete is scoped to
// one join instance, which is why leaveVoiceChannelWithRetry may run it after the
// lock is released.
func (t *voiceTxn) deleteRow(ctx context.Context, chID int64, joinedAt string) (bool, error) {
	return t.h.voiceReg.deleteJoinRow(ctx, t.h, t.userID, chID, joinedAt)
}

// deleteJoinRow is deleteRow without the handle. Safe without the member lock
// because the delete is scoped to one join instance (userID, chID, joinedAt), so a
// late run cannot touch a newer join. It takes the hub for its VoiceStore.
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

// takeParked removes and returns userID's grace entry (or nil) and stops its timer.
// Zero chID matches any entry; otherwise it must park that channel. Taking under
// the member lock keeps a resuming socket's inherit and the expiry teardown from
// both running (expireVoiceGrace's takeForExpiry).
func (t *voiceTxn) takeParked(chID int64) *voiceGraceEntry {
	return t.h.voiceReg.voiceGrace.takeJoin(t.userID, chID, "")
}

// takeParkedOfSession is takeParked limited to an entry tokenHash's session parked:
// a device reloading discards its own parked call, never another device's.
func (t *voiceTxn) takeParkedOfSession(tokenHash string) *voiceGraceEntry {
	g := &t.h.voiceReg.voiceGrace
	if e := g.get(t.userID); e == nil || e.client.tokenHash != tokenHash {
		return nil
	}
	return g.take(t.userID)
}

// dropParked drops userID's grace entry for chID whatever its join token, for a
// channel being torn down under every member.
func (t *voiceTxn) dropParked(chID int64) {
	t.takeParked(chID)
}

// transfer hands old's slot to c when a new connection replaces it and returns the
// voice channel old was in (0 for none) so the caller can re-run the key-holder
// election there. It empties old and moves everything it held, field by field, in
// one critical section:
//   - the moderator's pending mute/deafen always moves: it lives only on the client
//     between a move's eviction (which deletes its row) and the target's re-join,
//     so any replacement, resume or full resync must carry it;
//   - the membership (channel, token, completed flag, E2EE key) moves only when
//     resume is true, c is not already in a channel and old's join had completed. A
//     join still racing its own supersession guards would read the move as an
//     eviction and abandon itself with its row left behind, so an incomplete one
//     stays with old and is cleared; the next sweep reaps its row.
//
// The caller strips old's pub/sub subscriptions and subscribes c to the channel it
// now holds. TestVoiceRegistry_TransferCarriesEveryField fails when a voiceSlot
// field is neither moved nor reset here.
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

// stashModFlags stashes a moderator-imposed mute/deafen on c, replacing any earlier
// stash. A moderator move runs it in the same txn as the eviction
// (EvictForModeratorMove), so the target's own channel switch cannot take the stash
// between the two.
func (t *voiceTxn) stashModFlags(c *Client, serverMuted, serverDeafened bool, serverMutedBy *int64) {
	c.voice.stashModFlags(serverMuted, serverDeafened, serverMutedBy)
}

// adoptParked installs a parked grace snapshot as c's membership; it refuses (false)
// when c is already in a channel.
func (t *voiceTxn) adoptParked(c *Client, snap slotSnap) bool {
	return c.voice.adopt(snap)
}

// setJoinToken adopts tok as c's join token, which token refresh does when the client
// had none cached. It sets only the token, only while c is in voice with an empty
// token, leaving the completed flag and the rest alone; a cached token is never
// overwritten.
func (t *voiceTxn) setJoinToken(c *Client, tok string) {
	c.voice.adoptJoinToken(tok)
}
