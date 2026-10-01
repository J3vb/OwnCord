package ws

// voice_reconcile.go — RT-3: the polling reconciler.
//
// No shipped configuration makes the companion LiveKit send webhooks (see
// OC-0238), so participant_left never arrives and nothing removes a
// membership whose SFU participant died with the media path (a severed UDP
// flow). The voice_states row and the client's voiceChID both still name the
// channel, so sweepStaleVoiceStates — which compares the row against the
// client, not against the SFU — never sees it. Ghosts hold slots, and a ghost
// key holder stalls every new joiner's key exchange.
//
// This closes the gap by polling: once a tick, ListParticipants for every
// room that has a row or that the SFU has open, and reconcile the SFU's
// participant set against the DB. It runs on the startSweep pattern, never
// on the dispatch goroutine, because ListParticipants is a network round trip.
//
// The reap is deliberate about false positives: a participant that is absent
// on one tick is only a candidate (the media path can blip, and an in-flight
// join has not reached the SFU yet), so it is reaped on the SECOND
// consecutive miss. A transient ListParticipants failure skips the room
// entirely rather than reading "no participants" as all-ghosts.

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// voiceReconcileGraceTicks is how many consecutive ticks a participant may be
// absent from the SFU before the reconciler reaps its membership. Two ticks
// (one full interval of tolerance) keeps a momentary media blip or an
// in-flight join from kicking a live user.
const voiceReconcileGraceTicks = 2

// voiceReconcileState is the reconciler's cross-tick memory: how many
// consecutive ticks an exact SFU identity (user + join token) has been missing
// from its room. Keyed by identity so a rejoin (a new joinedAt) starts a fresh
// count, and a member who left voice has its entry pruned.
type voiceReconcileState struct {
	mu      syncutil.Mutex
	missing map[string]int
}

// miss records one absent tick for identity and returns the new count.
func (s *voiceReconcileState) miss(identity string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.missing == nil {
		s.missing = map[string]int{}
	}
	s.missing[identity]++
	return s.missing[identity]
}

// clear forgets identity (it was seen this tick, or has been reaped).
func (s *voiceReconcileState) clear(identity string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.missing, identity)
}

// prune drops counters whose identity no longer belongs to any voice_states
// row, so a member who left voice does not carry an entry for the process
// lifetime. Identities still backed by a row are kept.
func (s *voiceReconcileState) prune(live map[string]struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.missing {
		if _, ok := live[id]; !ok {
			delete(s.missing, id)
		}
	}
}

// reconcileVoiceMembership is the polling reconciler's entry point, run from
// the hub's voice-reconcile ticker through startSweep.
func (h *Hub) reconcileVoiceMembership() {
	if h.livekit == nil || h.voice == nil {
		return
	}
	// Hub run-loop sweeper — no request tie.
	ctx := context.Background()

	rows, err := h.voice.AllStates(ctx)
	if err != nil {
		slog.Warn("voice reconcile: AllStates failed", "err", err)
		return
	}
	// voiceMembership is the slice of a row the reconciler needs: the two
	// fields that build the SFU identity. Kept local so this file does not
	// import db (the DBImportAllow inventory only shrinks; the read goes
	// through the VoiceStore seam, readers.go).
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
	h.voiceReconcile.prune(live)
	// Also visit rooms no row names: a sole member removed from voice leaves
	// a room with no rows, and a participant there (a replayed, still-valid
	// token) is an orphan too. A failure only narrows this tick to rooms with
	// rows.
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
		identities, listErr := h.livekit.ListParticipants(ctx, channelID)
		if listErr != nil {
			// A transient failure is not "the room is empty": treating it as
			// such would reap every member of the room on the next tick.
			// Skip the room; the next tick retries.
			slog.Warn("voice reconcile: ListParticipants failed, skipping room",
				"err", listErr, "channel_id", channelID)
			continue
		}
		present := make(map[string]struct{}, len(identities))
		for _, id := range identities {
			present[id] = struct{}{}
		}

		// Reap memberships whose SFU participant is gone, after the grace.
		expected := make(map[string]struct{}, len(roomRows))
		for _, row := range roomRows {
			id := participantIdentity(row.userID, row.joinedAt)
			expected[id] = struct{}{}
			if _, ok := present[id]; ok {
				h.voiceReconcile.clear(id)
				continue
			}
			if h.voiceReconcile.miss(id) >= voiceReconcileGraceTicks {
				h.reconcileReap(ctx, channelID, row.userID, row.joinedAt)
				h.voiceReconcile.clear(id)
			}
		}

		h.reconcileRemoveOrphans(ctx, channelID, identities, expected)
	}
}

// reconcileRemoveOrphans removes SFU participants that no voice_states row
// names — an identity for a user with no row at all, or one from a superseded
// join instance whose row now carries a newer token. The snapshot predates
// this room's list, so each candidate's row is re-read first: a join committed
// since then is live, not an orphan.
func (h *Hub) reconcileRemoveOrphans(ctx context.Context, channelID int64, identities []string, expected map[string]struct{}) {
	for _, id := range identities {
		if _, ok := expected[id]; ok {
			continue
		}
		userID, token, parseErr := parseParticipantIdentity(id)
		if parseErr != nil {
			// Not an OwnCord identity (a room agent, or a future
			// participant kind): never remove what we cannot attribute.
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

// reconcileReap removes one membership whose SFU participant is confirmed
// gone. A live client holding exactly this join instance is cleared (its row
// and SFU participant are gone, so continuing to show it in voice would be
// the ghost this reconciler exists to end), then the shared leave tail deletes
// the row, broadcasts voice_leave with the leaver included, and re-elects the
// key holder.
func (h *Hub) reconcileReap(ctx context.Context, channelID int64, userID int64, joinedAt string) {
	c := h.GetClient(userID)
	if c != nil && h.clearExactJoin(c, channelID, joinedAt) {
		h.finishVoiceLeave(ctx, c, channelID, joinedAt, voiceLeaveReasonReconciled)
		return
	}
	// No client holds this exact instance (it left, reconnected, or moved).
	// Delete the row if it still matches, then broadcast the leave for any
	// bystander and re-elect the key holder. Mirrors the webhook's stale-row
	// cleanup (webhookLeftCleanupClient's else branch).
	h.voiceGrace.takeJoin(userID, channelID, joinedAt)
	deleted, err := h.voice.LeaveIfMatch(ctx, userID, channelID, joinedAt)
	if err != nil {
		slog.Error("voice reconcile: LeaveIfMatch failed", "err", err,
			"user_id", userID, "channel_id", channelID)
		return
	}
	if !deleted {
		return
	}
	h.broadcastVoiceEventWithLeaver(ctx, channelID, buildVoiceLeave(channelID, userID), userID)
	h.updateKeyHolder(channelID)
	if h.livekit != nil {
		_ = h.livekit.RemoveParticipant(ctx, channelID, userID, joinedAt)
	}
	slog.Warn("voice reconcile: reaped voice membership with no SFU participant",
		"user_id", userID, "channel_id", channelID)
}

// clearExactJoin clears c's voice state only while it still names this exact
// join instance (channel AND token), reporting whether it did. Token-scoped
// unlike clearVoiceStateIfMatch: a same-channel rejoin between the reconcile
// snapshot and this call has a new token, and its membership must survive.
// Inlined under voiceMu the same way webhookLeftCleanupClient does.
func (h *Hub) clearExactJoin(c *Client, channelID int64, joinedAt string) bool {
	c.voiceMu.Lock()
	matched := c.voiceChID == channelID && c.voiceJoinToken == joinedAt
	if matched {
		c.voiceChID = 0
		c.voiceJoinToken = ""
		c.voiceJoinCompleted = false
		c.e2eePubKey = ""
		c.e2eeSignature = ""
	}
	c.voiceMu.Unlock()
	if matched {
		h.pubsub.Unsubscribe(c, VoiceTopic(channelID))
	}
	return matched
}
