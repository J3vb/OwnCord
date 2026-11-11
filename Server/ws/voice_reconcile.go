package ws

// voice_reconcile.go: the polling reconciler. No shipped configuration makes the companion
// LiveKit send webhooks, so participant_left never arrives and nothing removes a membership
// whose SFU participant died with the media path. The row and the client's voiceChID still
// name the channel, so sweepStaleVoiceStates (row vs client, not SFU) never sees it; ghosts
// hold slots and a ghost key holder stalls every joiner's key exchange. Once a tick it calls
// ListParticipants for every room with a row or open at the SFU and reconciles against the
// DB, via startSweep and never on the dispatch goroutine (a network round trip). A
// participant absent on one tick is only a candidate (a media blip, or an in-flight join not
// yet at the SFU): it is reaped on the SECOND consecutive miss. A failed ListParticipants
// skips the room rather than reading "no participants" as all-ghosts.

import (
	"context"
	"log/slog"
)

// voiceReconcileGraceTicks is how many consecutive ticks a participant may be absent from
// the SFU before reaping; two tolerate a media blip or an in-flight join.
const voiceReconcileGraceTicks = 2

func (h *Hub) reconcileVoiceMembership(ctx context.Context) {
	if h.livekit == nil || h.voice == nil {
		return
	}
	rows, err := h.voice.AllStates(ctx)
	if err != nil {
		slog.Warn("voice reconcile: AllStates failed", "err", err)
		return
	}
	// voiceMembership is the two row fields that build the SFU identity. Local so this file
	// does not import db (the DBImportAllow inventory only shrinks); reads go through VoiceStore.
	type voiceMembership struct {
		userID   int64
		joinedAt string
	}
	byRoom := make(map[int64][]voiceMembership)
	live := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		id := participantIdentity(row.UserID, row.JoinedAt)
		byRoom[row.ChannelID] = append(byRoom[row.ChannelID], voiceMembership{row.UserID, row.JoinedAt})
		live[id] = struct{}{}
	}
	h.voiceHub.reconcile.Prune(live)
	// Also visit rooms no row names: a sole member removed from voice leaves a room with no
	// rows, and a participant there (a replayed token) is an orphan too. A failure only narrows
	// this tick to rooms with rows.
	roomIDs, err := h.livekit.ListRoomChannelIDs(ctx)
	if err != nil {
		slog.Warn("voice reconcile: ListRooms failed, checking rooms with rows only", "err", err)
	}
	for _, channelID := range roomIDs {
		if _, ok := byRoom[channelID]; !ok {
			byRoom[channelID] = nil
		}
	}

	for channelID, roomRows := range byRoom {
		if ctx.Err() != nil {
			return
		}
		identities, listErr := h.livekit.ListParticipants(ctx, channelID)
		if listErr != nil {
			// A transient failure is not "the room is empty": reaping on it would remove every member next
			// tick.
			slog.Warn("voice reconcile: ListParticipants failed, skipping room",
				"err", listErr, "channel_id", channelID)
			continue
		}
		present := make(map[string]struct{}, len(identities))
		for _, id := range identities {
			present[id] = struct{}{}
		}

		expected := make(map[string]struct{}, len(roomRows))
		for _, row := range roomRows {
			if ctx.Err() != nil {
				return
			}
			id := participantIdentity(row.userID, row.joinedAt)
			expected[id] = struct{}{}
			if _, ok := present[id]; ok {
				h.voiceHub.reconcile.Clear(id)
				continue
			}
			if h.voiceHub.reconcile.Miss(id) >= voiceReconcileGraceTicks {
				h.reconcileReap(ctx, channelID, row.userID, row.joinedAt)
				h.voiceHub.reconcile.Clear(id)
			}
		}

		h.reconcileRemoveOrphans(ctx, channelID, identities, expected)
	}
}

// reconcileRemoveOrphans removes SFU participants no voice_states row names (no row, or a
// superseded join instance with a newer token). The snapshot predates this room's list, so
// each candidate's row is re-read first: a join committed since is live.
func (h *Hub) reconcileRemoveOrphans(ctx context.Context, channelID int64, identities []string, expected map[string]struct{}) {
	for _, id := range identities {
		if _, ok := expected[id]; ok {
			continue
		}
		userID, token, parseErr := parseParticipantIdentity(id)
		if parseErr != nil {
			// Not an OwnCord identity (room agent, future participant kind): never remove what we cannot
			// attribute.
			slog.Warn("voice reconcile: leaving unparseable SFU identity",
				"identity", id, "channel_id", channelID)
			continue
		}
		row, stateErr := h.voice.State(ctx, userID)
		if stateErr != nil {
			slog.Warn("voice reconcile: re-reading orphan's voice state failed, skipping",
				"err", stateErr, "user_id", userID, "channel_id", channelID)
			continue
		}
		if row != nil && row.ChannelID == channelID && row.JoinedAt == token {
			continue
		}
		if err := h.livekit.RemoveParticipant(ctx, channelID, userID, token); err != nil {
			slog.Warn("voice reconcile: removing orphan participant failed",
				"err", err, "user_id", userID, "channel_id", channelID)
			continue
		}
		slog.Info("voice reconcile: removed orphan SFU participant",
			"user_id", userID, "channel_id", channelID)
	}
}

// reconcileReap removes one membership whose SFU participant is confirmed gone. A live
// client holding exactly this join instance is cleared (showing it in voice would be the
// ghost), then the shared leave tail deletes the row, broadcasts voice_leave with the
// leaver included, and re-elects the key holder.
func (h *Hub) reconcileReap(ctx context.Context, channelID int64, userID int64, joinedAt string) {
	txn := h.begin(userID)
	defer txn.end()
	var reaped *Client
	for _, c := range h.clientsOf(userID) {
		if txn.clearExact(c, channelID, joinedAt) {
			reaped = c
			break
		}
	}
	if reaped != nil {
		tailCtx, cancelTail := h.sweepTailCtx(ctx)
		defer cancelTail()
		h.finishVoiceLeave(tailCtx, txn, reaped, channelID, joinedAt, voiceLeaveReasonReconciled)
		return
	}
	// No client holds this exact instance (left, reconnected or moved): delete the row if it still matches,
	// then broadcast the leave for bystanders and re-elect, as the webhook's stale-row cleanup does.
	deleted, err := txn.deleteRow(ctx, channelID, joinedAt)
	if err != nil {
		slog.Error("voice reconcile: LeaveIfMatch failed", "err", err,
			"user_id", userID, "channel_id", channelID)
		return
	}
	if !deleted {
		return
	}
	tailCtx, cancelTail := h.sweepTailCtx(ctx)
	defer cancelTail()
	h.broadcastVoiceEventWithLeaver(tailCtx, channelID, buildVoiceLeave(channelID, userID), userID)
	h.updateKeyHolder(channelID)
	h.removeLiveKitParticipantAsync(tailCtx, channelID, userID, joinedAt, "reconcileReap")
	slog.Warn("voice reconcile: reaped voice membership with no SFU participant",
		"user_id", userID, "channel_id", channelID)
}
