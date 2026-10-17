package ws

// voice_registry_txn.go — WP 5.3b: every voice membership write goes through a
// lock handle.
//
// Hub.begin takes a user's voice membership lock (voiceMember, WP 1D-10) and
// returns a *voiceTxn. Holding one is the compile-time proof that a path owns
// the lock, and the methods below are the only code that changes the slot's
// channel/token/completed flag/E2EE key, deletes a voice_states membership
// row, or touches the VoiceTopic subscription that goes with a membership.
// The invariants package pins that boundary (voice-membership-writes): the
// slot field writes, VoiceStore.Join and VoiceStore.LeaveIfMatch may only be
// spelled in voice_registry*.go.
//
// Lock order and the rules for what may run under the lock are written down
// in voice_registry.go and are unchanged. Self and moderator flag rows,
// broadcasts, key-holder election, permission checks and SFU RPCs stay with
// their callers.

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// errVoiceJoinReadBack marks a persistJoin whose row committed but could not be
// read back; the caller rolls the half-made join back.
var errVoiceJoinReadBack = errors.New("voice join: read back the committed row")

// slotSnap is what a clear removed from a slot: the channel, the join token
// and whether that join had completed (voiceSlot.voiceJoinCompleted).
type slotSnap struct {
	chID      int64
	joinToken string
	completed bool
}

// voiceTxn is a handle on one user's voice membership lock.
type voiceTxn struct {
	h      *Hub
	userID int64
	unlock func() // nil for a borrowed handle (Hub.heldTxn)
}

// begin takes userID's voice membership lock and returns the handle that
// proves it. Release it with end, normally `defer txn.end()`. Callers hold none
// of the locks to the right of voiceMember in the order (voice_registry.go).
func (h *Hub) begin(userID int64) *voiceTxn {
	return &voiceTxn{h: h, userID: userID, unlock: h.voiceMember.lock(userID)}
}

// heldTxn returns a borrowed handle for a helper whose caller already holds
// userID's lock through begin; end on it does nothing. Callers: handleVoiceLeave,
// handleVoiceLeaveIfStillIn and leaveVoiceChannelWithRetry (voice_leave.go),
// leaveVoiceOnDisconnect (voice_grace.go), rollbackVoiceJoin (voice_join.go) and
// freshConnectCleanStaleVoice (serve_ready.go). They are also driven directly by
// tests, so their signatures cannot take the caller's txn; the retry goroutine's
// delete is scoped to one join instance and needs no lock. WP 5.3c/5.3d retire
// it (VoiceMutatorAllow in invariants lists its callers).
func (h *Hub) heldTxn(userID int64) *voiceTxn {
	return &voiceTxn{h: h, userID: userID}
}

// end releases the lock. Calling it again, or on a borrowed handle, does
// nothing.
func (t *voiceTxn) end() {
	if t.unlock == nil {
		return
	}
	unlock := t.unlock
	t.unlock = nil
	unlock()
}

// persistJoin inserts the voice_states row under capacity, reads the committed
// row back and then publishes the slot's membership, in BUG-088 order: the
// slot is set as soon as the row is confirmed, before the permission checks and
// LiveKit token mint that follow. A full channel returns an error wrapping
// service.ErrVoiceChannelFull. A row that cannot be read back returns
// errVoiceJoinReadBack and leaves the slot untouched.
func (t *voiceTxn) persistJoin(ctx context.Context, c *Client, chID int64, capacity int) (*db.VoiceState, error) {
	if err := t.h.voice.Join(ctx, t.userID, chID, capacity); err != nil {
		return nil, fmt.Errorf("persist voice join: %w", err)
	}

	// Load the persisted row immediately so later cleanup can target this exact
	// join instance even if the user rejoins the same channel.
	state, err := t.h.voice.State(ctx, t.userID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errVoiceJoinReadBack, err)
	}
	if state == nil {
		return nil, fmt.Errorf("%w: no row", errVoiceJoinReadBack)
	}

	// The stale-voice sweep snapshots clients without the voice lock, so it can
	// still see 0 here, but its delete runs under the lock and rechecks first
	// (WP 1D-10). A failure further down unwinds this via rollbackVoiceJoin.
	if voiceJoinPostCommitRaceHook != nil {
		voiceJoinPostCommitRaceHook(c)
	}
	c.setState(chID, state.JoinedAt)
	return state, nil
}

// markCompleted records that the join for (chID, token) passed
// voiceJoinComplete's supersession guard and, only then, subscribes c to
// VoiceTopic(chID). The compare and the flag are one slot critical section; it
// returns false, and subscribes nothing, when the slot has moved on. Every
// clear below unsubscribes again, so the OC-0219 pairing cannot be forgotten.
func (t *voiceTxn) markCompleted(c *Client, chID int64, token string) bool {
	if !c.markCompletedIfMatch(chID, token) {
		return false
	}
	t.h.pubsub.Subscribe(c, VoiceTopic(chID))
	return true
}

// clear empties c's slot (channel, token, completed flag and E2EE key) and
// drops its VoiceTopic subscription, returning what was cleared. Every path
// that takes a client out of voice while its WS stays up needs the pair:
// clearing without unsubscribing leaves the socket receiving that room's
// voice_e2ee_announce relays (which carry no channel_id to filter on) for the
// connection's lifetime.
func (t *voiceTxn) clear(c *Client) slotSnap {
	chID, token, completed := c.clearState()
	if chID != 0 {
		t.h.pubsub.Unsubscribe(c, VoiceTopic(chID))
	}
	return slotSnap{chID: chID, joinToken: token, completed: completed}
}

// clearIfChannel is clear conditioned on the slot still naming chID, reporting
// whether it cleared. Delayed evictions decided against a snapshotted channel
// use it so a membership committed after the snapshot survives.
func (t *voiceTxn) clearIfChannel(c *Client, chID int64) (slotSnap, bool) {
	token, ok := c.clearIfChannel(chID)
	if !ok {
		return slotSnap{}, false
	}
	t.h.pubsub.Unsubscribe(c, VoiceTopic(chID))
	return slotSnap{chID: chID, joinToken: token}, true
}

// clearExact is clear conditioned on the slot still naming this exact join
// instance (channel AND token), reporting whether it cleared. A same-channel
// rejoin has a new token, and its membership must survive. An empty token never
// matches. It resets the completed flag along with the rest: the LiveKit
// webhook's clear used to leave it set, so a later reconnect could hand a new
// socket completed=true with channel 0.
func (t *voiceTxn) clearExact(c *Client, chID int64, token string) (slotSnap, bool) {
	if token == "" {
		return slotSnap{}, false
	}
	completed, ok := c.clearExact(chID, token)
	if !ok {
		return slotSnap{}, false
	}
	t.h.pubsub.Unsubscribe(c, VoiceTopic(chID))
	return slotSnap{chID: chID, joinToken: token, completed: completed}, true
}

// deleteRow removes the voice_states row for the join instance (chID,
// joinedAt) and reports whether a row was deleted. It drops the matching grace
// entry first, so a failed delete leaves the row for the stale sweep with no
// grace timer left to tear it down twice. With no VoiceStore it only drops the
// entry. The delete is scoped to one join instance, which is why the retry in
// leaveVoiceChannelWithRetry may run it after the lock is released.
func (t *voiceTxn) deleteRow(ctx context.Context, chID int64, joinedAt string) (bool, error) {
	t.h.voiceGrace.takeJoin(t.userID, chID, joinedAt)
	if t.h.voice == nil {
		return false, nil
	}
	deleted, err := t.h.voice.LeaveIfMatch(ctx, t.userID, chID, joinedAt)
	if err != nil {
		return false, fmt.Errorf("delete voice row: %w", err)
	}
	return deleted, nil
}

// dropParked drops userID's grace entry for chID whatever its join token, for
// a channel being torn down under every member.
func (t *voiceTxn) dropParked(chID int64) {
	t.h.voiceGrace.takeJoin(t.userID, chID, "")
}

// setJoinToken adopts tok as c's join token, which the token refresh does when
// the client had none cached. It sets only the token, only while c is in voice
// with an empty token, and leaves the completed flag and the rest of the slot
// alone; a cached token is never overwritten.
func (t *voiceTxn) setJoinToken(c *Client, tok string) {
	c.adoptJoinToken(tok)
}
