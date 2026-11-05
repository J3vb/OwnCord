package ws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/db"
)

func (h *Hub) handleFreshConnect(ctx context.Context, conn *websocket.Conn, c *Client) error {
	// Bound concurrent ready builds. Taken before any handshake state change or
	// registration, so a waiting connect neither touches the database nor queues
	// broadcasts it cannot drain yet.
	release, admitted := h.admitReady(ctx)
	if !admitted {
		refuseBusy(ctx, conn, c)
		return fmt.Errorf("handleFreshConnect: ready builds saturated for user %d", c.userID)
	}
	defer release()
	// Use the configured seam, never a caller-supplied handle, so a service-backed or
	// instrumented Ready reader intercepts the snapshot reads below.
	database := h.readers.Ready
	h.freshConnectSettleVoice(ctx, c)

	// c.user is the auth-time snapshot; re-read it so the ready payload and inherited
	// subscriptions use the user's current role (as reconnectPrecheck does). Fail closed.
	if err := h.refreshUserSnapshot(ctx, database, c); err != nil {
		slog.Error("ws: user re-read failed, disconnecting", "user_id", c.userID, "err", err)
		_ = conn.Close(websocket.StatusInternalError, "user lookup failed")
		return err
	}

	// Fail closed: if the role lookup fails, disconnect rather than serve a permissive
	// ready with nil role. It is the same read refreshUserSnapshot just made, so
	// auth_ok.role_ids and ready permissions come from one snapshot.
	heldRoles := c.held
	if heldRoles == nil {
		slog.Error("ws: role lookup failed, disconnecting", "user_id", c.userID, "role_id", c.user.RoleID)
		_ = conn.Close(websocket.StatusInternalError, "role lookup failed")
		return fmt.Errorf("role lookup failed for user %d", c.userID)
	}
	// Top role identity with the OR of every held mask.
	userRole := heldRoles.Effective()

	// Register before writing auth_ok + ready so broadcasts during the write window
	// queue in the client's send buffer (writePump has not started; they drain later).
	allowedChannelIDs := h.gateResumeChannel(ctx, database, c)
	if freshConnectPreRegisterRaceHook != nil {
		freshConnectPreRegisterRaceHook()
	}
	txn := h.begin(c.userID)
	h.registerNow(c, allowedChannelIDs, txn)
	txn.end()

	// registerNow is the earliest point a revocation racing this handshake's DB work
	// could find this socket, so re-read the session now (postRegisterSessionRecheck).
	// On abort it already ran the failed-handshake teardown; only conn needs closing.
	if v := h.postRegisterSessionRecheck(ctx, c); v != postRegisterOK {
		closeAbortedHandshake(ctx, conn, v)
		return fmt.Errorf("handleFreshConnect: session revoked or user banned for user %d during handshake", c.userID)
	}

	// The re-read above and registerNow are not atomic: a role change committing in
	// between finds this socket absent from h.clients (its revokeUnreadableChannels
	// early-returns) yet builds our inherited subscriptions from the old role. One PK
	// re-read after registration makes the orderings meet: a commit visible here is
	// pruned by our own revoke pass, and one not yet visible runs its revoke lookup
	// after our registerNow and finds us. Scoped to the resume-fallback path: a pure
	// fresh connect inherits no subscriptions.
	if c.lastSeq > 0 {
		// Compared by the held-role set: adding or removing a non-top role changes what
		// they may read without moving the users.role_id mirror.
		if fresh, err := database.GetMemberRoles(ctx, c.userID); err != nil || fresh == nil || !sameRoleSet(fresh.IDs, heldRoles.IDs) {
			//nolint:contextcheck // revokeUnreadableChannels takes no context by design (admin HubBroadcaster interface).
			h.revokeUnreadableChannels(c.userID)
		}
	}

	// Settle the status before buildReady reads members so ready and the presence
	// broadcast cannot disagree.
	h.applyConnectStatus(ctx, c)

	slog.Info("ws sending auth_ok", "user_id", c.userID, "username", c.user.Username, "role", c.roleName)
	if err := handshakeWrite(ctx, conn, h.buildAuthOK(ctx, c.user, c.roleName, c.roleIDs, "none")); err != nil {
		slog.Warn("ws: failed to send auth_ok", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	// This ready carries every member's status, so it settles any presence resync owed.
	// Cleared before the build so a drop after it marks the user again; restored if
	// the ready never reaches the client.
	owedResync := h.takeOwedResync(c)
	ready, readyErr := h.buildFreshReady(ctx, database, c, userRole)
	release() // the write below is the peer's pace, not the database's
	if err := h.sendFreshReady(ctx, conn, c, ready, readyErr, owedResync); err != nil {
		return err
	}
	h.announceFreshConnect(c)

	return nil
}

// freshConnectSettleVoice runs a fresh connect's voice steps before ready is
// built, under the voice lock so the old socket's voice paths cannot interleave.
// The lock is released for the DB reads and retaken for registerNow; every row
// deleter also drops the grace entry, so the gap is safe.
func (h *Hub) freshConnectSettleVoice(ctx context.Context, c *Client) {
	txn := h.begin(c.userID)
	defer txn.end()
	// A fresh connect ends its own session's parked grace window (registerNow drops
	// it); a replay-failure fallback may inherit one only while its row exists.
	if c.lastSeq == 0 {
		txn.takeParkedOfSession(c.tokenHash) // another device's parked call stays parked
	} else {
		h.dropOrphanVoiceGrace(ctx, c.userID)
	}
	// Clean stale voice state before building ready: an F5 reload while in voice
	// leaves the previous session's row, which would show in ready and need a
	// voice_leave broadcast to other clients.
	if vs, err := h.voice.State(ctx, c.userID); err == nil && vs != nil {
		h.freshConnectCleanStaleVoice(ctx, txn, c, vs)
	}
}

// freshConnectCleanStaleVoice removes the voice state left by this user's previous
// session, unless that is the still-registered connection this one will inherit from.
func (h *Hub) freshConnectCleanStaleVoice(ctx context.Context, txn *voiceTxn, c *Client, vs *db.VoiceState) {
	// Replay-failure fallback (lastSeq > 0): registerNow transfers the
	// still-registered old connection's live voice state into this client. Deleting
	// the row (and the LiveKit participant, whose removal token is the JoinedAt being
	// transferred) would leave the user in voice on the hub only: voice_join bounces
	// off ALREADY_JOINED and sweepStaleVoiceStates never heals memory-without-row.
	// If the old client unregisters before registerNow, the next sweep reaps the row.
	//
	// The call belongs to another device when a live connection of a different
	// session holds it or that session parked it in the grace window. This connection
	// is only a new device (or a reload of another) and must not end it. A
	// same-session F5 falls through and cleans its own stale call.
	if h.voiceHeldByOtherSession(c, vs.ChannelID) {
		slog.Info("ws fresh connect: leaving another device's voice state",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		return
	}
	if old := h.sessionClient(c.userID, c.tokenHash); c.lastSeq > 0 && old != nil && old.voice.channel() == vs.ChannelID {
		slog.Info("ws fresh connect: keeping voice state for replay-failure fallback",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		return
	}
	// A replay-failure fallback whose previous socket parked this membership keeps
	// the row for registerNow to inherit (deleting it would leave an inherited state
	// with no row). Any other fresh connect or mismatched grace entry means the call
	// is over: stop the window so its timer cannot re-run finishVoiceLeave over a
	// cleaned row.
	if c.lastSeq > 0 && h.voiceHub.reg.voiceGrace.has(c.userID, vs.ChannelID) {
		slog.Info("ws fresh connect: keeping graced voice state",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		return
	}
	txn.takeParked(0) // same-session or unowned entry only: another session's returned above
	slog.Info("ws fresh connect: cleaning stale voice state",
		"user_id", c.userID, "channel_id", vs.ChannelID)
	if _, delErr := txn.deleteRow(ctx, vs.ChannelID, vs.JoinedAt); delErr != nil {
		slog.Warn("ws fresh connect: LeaveVoiceChannelIfMatch failed", "err", delErr)
	}
	// The still-registered old *Client (if any) is otherwise cleared only by
	// registerNow, which two early-return paths in handleFreshConnect can skip. Its
	// in-memory voiceChID and key-holder election would then survive as a
	// memory-without-row ghost sweepStaleVoiceStates cannot see (it iterates DB rows).
	// Clearing here keeps this function self-sufficient; registerNow's later
	// re-election becomes a redundant no-op.
	if old := h.sessionClient(c.userID, c.tokenHash); old != nil {
		txn.clearIfChannel(old, vs.ChannelID)
	}
	h.updateKeyHolder(vs.ChannelID)
	h.broadcastVoiceEvent(ctx, vs.ChannelID, c.userID, buildVoiceLeave(vs.ChannelID, c.userID))
	// Pass the stale join token so removal hits only that participant: the identity
	// includes joinedAt, so a quick rejoin's new session is not removed.
	h.removeLiveKitParticipantAsync(ctx, vs.ChannelID, c.userID, vs.JoinedAt, "ws fresh connect:")
}
