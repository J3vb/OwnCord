package ws

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"github.com/twitchtv/twirp"
)

// webhookMaxBodyBytes bounds the request body so an unauthenticated caller cannot force unbounded reads.
const webhookMaxBodyBytes = 64 * 1024

// NewLiveKitWebhookHandler returns an HTTP handler for LiveKit webhook events,
// syncing room state back into voice_states, mainly crash recovery when a
// participant leaves LiveKit without a WS voice_leave. Speaker detection is
// client-side (RoomEvent.ActiveSpeakersChanged, lower latency).
func (h *Hub) NewLiveKitWebhookHandler(apiKey, apiSecret string) http.HandlerFunc {
	// The SDK receiver verifies the token signature and that its sha256 claim matches
	// the body hash, so a captured token cannot be replayed against a forged payload.
	provider := auth.NewSimpleKeyProvider(apiKey, apiSecret)

	return func(w http.ResponseWriter, r *http.Request) {
		// Check Authorization before reading the body so unauthenticated requests allocate nothing.
		if r.Header.Get("Authorization") == "" {
			slog.Warn("livekit webhook: missing Authorization header")
			httperr.Write(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "unauthorized")
			return
		}

		// Bound the body before the SDK reads it (ReceiveWebhookEvent uses an unbounded io.ReadAll).
		r.Body = http.MaxBytesReader(w, r.Body, webhookMaxBodyBytes)

		// ReceiveWebhookEvent verifies the JWT signature, the body-hash claim and
		// exp/nbf, then parses the payload, so verification is bound to the request body
		// (no forgery or replay).
		event, err := webhook.ReceiveWebhookEvent(r, provider)
		if err != nil {
			slog.Warn("livekit webhook: verification failed", "error", err)
			httperr.Write(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "unauthorized")
			return
		}

		slog.Info("livekit webhook received",
			"event", event.Event,
			"room", event.GetRoom().GetName(),
			"participant", event.GetParticipant().GetIdentity(),
		)

		switch event.Event {
		case "participant_joined":
			if err := h.handleWebhookParticipantJoined(r.Context(), event); err != nil {
				// LiveKit retries failed deliveries. Acknowledging a failed reconciliation loses
				// the only record of a participant with no voice_states row for the DB sweep to find.
				httperr.Write(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "voice reconciliation temporarily unavailable")
				return
			}
		case "participant_left":
			h.handleWebhookParticipantLeft(r.Context(), event)
		default:
			slog.Debug("livekit webhook: unhandled event", "event", event.Event)
		}

		w.WriteHeader(http.StatusOK)
	}
}

// parseParticipantIdentity extracts a user ID and optional join token from an
// identity "user-{id}" or "user-{id}:{joinToken}".
func parseParticipantIdentity(identity string) (int64, string, error) {
	if !strings.HasPrefix(identity, "user-") {
		return 0, "", fmt.Errorf("invalid identity format: %s", identity)
	}
	body := identity[5:]
	idPart, joinToken, _ := strings.Cut(body, ":")
	userID, err := strconv.ParseInt(idPart, 10, 64)
	if err != nil {
		return 0, "", err
	}
	return userID, joinToken, nil
}

// parseRoomChannelID extracts a channel ID from a room name "channel-{id}".
func parseRoomChannelID(roomName string) (int64, error) {
	if !strings.HasPrefix(roomName, "channel-") {
		return 0, fmt.Errorf("invalid room name format: %s", roomName)
	}
	return strconv.ParseInt(roomName[8:], 10, 64)
}

func (h *Hub) handleWebhookParticipantJoined(ctx context.Context, event *livekit.WebhookEvent) error {
	// Detach from the triggering HTTP request before cleanup, like every sibling
	// teardown path (readPump's defer, unregisterFailedHandshake, rollbackVoiceJoin,
	// the hub sweeps). Otherwise LiveKit hanging up mid-request cancels r.Context(),
	// and the rogue-participant GetVoiceState/RemoveParticipant calls would wrongly
	// skip (a cancelled read looks like a transient error) or fail instead of evicting.
	ctx = context.WithoutCancel(ctx)

	p := event.GetParticipant()
	room := event.GetRoom()
	if p == nil || room == nil {
		return nil
	}

	userID, joinToken, err := parseParticipantIdentity(p.Identity)
	if err != nil {
		slog.Warn("livekit webhook: participant_joined bad identity",
			"identity", p.Identity, "error", err)
		return nil
	}

	channelID, err := parseRoomChannelID(room.Name)
	if err != nil {
		slog.Warn("livekit webhook: participant_joined bad room",
			"room", room.Name, "error", err)
		return nil
	}

	slog.Info("livekit webhook: participant joined",
		"user_id", userID,
		"channel_id", channelID,
		"room", room.Name)

	// Validate the participant has a matching voice_states row; a replayed token from a
	// previous session will not, so remove the rogue participant from LiveKit.
	if h.voice != nil {
		return h.webhookJoinedEnforceVoiceState(ctx, userID, channelID, joinToken)
	}
	return nil
}

// webhookJoinedEnforceVoiceState is the reconciliation stage of
// handleWebhookParticipantJoined: it removes the participant from the SFU when
// their row is missing, points at another channel or carries a different join
// token. Callers guarantee h.voice != nil.
func (h *Hub) webhookJoinedEnforceVoiceState(ctx context.Context, userID, channelID int64, joinToken string) error {
	state, stateErr := h.voice.State(ctx, userID)
	if stateErr != nil {
		// A transient read failure (I/O error, lock contention, maintenance) is not proof
		// of a rogue participant; treating it so would eject a legitimate one on a single
		// bad read. Leave them connected but make the webhook retryable: the DB sweep
		// cannot discover SFU participants with no persisted membership.
		slog.Error("livekit webhook: GetVoiceState failed, skipping rogue-participant check",
			"error", stateErr, "user_id", userID, "channel_id", channelID)
		return stateErr
	}
	if state == nil || state.ChannelID != channelID {
		slog.Warn("livekit webhook: rogue participant_joined — no matching voice state, removing",
			"user_id", userID, "channel_id", channelID)
		if h.livekit != nil {
			if rmErr := h.livekit.RemoveParticipant(ctx, channelID, userID, joinToken); rmErr != nil && !liveKitParticipantMissing(rmErr) {
				slog.Error("livekit webhook: failed to remove rogue participant",
					"error", rmErr, "user_id", userID, "channel_id", channelID)
				return rmErr
			}
		}
		return nil
	}
	// Verify the join token matches to prevent replay from old sessions.
	if joinToken != "" && state.JoinedAt != joinToken {
		slog.Warn("livekit webhook: stale join token on participant_joined, removing",
			"user_id", userID, "channel_id", channelID,
			"expected_token", state.JoinedAt, "got_token", joinToken)
		if h.livekit != nil {
			if rmErr := h.livekit.RemoveParticipant(ctx, channelID, userID, joinToken); rmErr != nil && !liveKitParticipantMissing(rmErr) {
				slog.Error("livekit webhook: failed to remove stale participant",
					"error", rmErr, "user_id", userID, "channel_id", channelID)
				return rmErr
			}
		}
		return nil
	}
	// A reconnect can reuse a token issued before a mute or permission change.
	// Reconcile current grants at the SFU even when the identity matches; the token's
	// original publication rights are not authority.
	if err := h.syncVoiceParticipantPermissions(ctx, userID, channelID, joinToken); err != nil && !liveKitParticipantMissing(err) {
		slog.Error("livekit webhook: failed to reconcile participant permissions",
			"error", err, "user_id", userID, "channel_id", channelID)
		return err
	}
	return nil
}

// liveKitParticipantMissing: a participant (or room) that disappeared before an
// eviction or permission update needs no reconciliation; other SDK errors stay retryable.
func liveKitParticipantMissing(err error) bool {
	var rpcErr twirp.Error
	return errors.As(err, &rpcErr) && rpcErr.Code() == twirp.NotFound
}

func (h *Hub) handleWebhookParticipantLeft(ctx context.Context, event *livekit.WebhookEvent) {
	// Detach from the triggering HTTP request before cleanup, like every sibling
	// teardown path. Otherwise LiveKit hanging up mid-request cancels r.Context(),
	// making channelReadAudience's GetChannel fail closed to an empty audience
	// (hub_broadcast.go) and silently dropping the voice_leave for anyone with
	// READ_MESSAGES who is not in the room. No sweep re-emits that broadcast, unlike the
	// DB row. It would also fail both LeaveVoiceChannelIfMatch branches below on their
	// synchronous first attempt.
	ctx = context.WithoutCancel(ctx)

	p := event.GetParticipant()
	room := event.GetRoom()
	if p == nil || room == nil {
		return
	}

	userID, joinToken, err := parseParticipantIdentity(p.Identity)
	if err != nil {
		slog.Warn("livekit webhook: participant_left bad identity",
			"identity", p.Identity, "error", err)
		return
	}

	channelID, err := parseRoomChannelID(room.Name)
	if err != nil {
		slog.Warn("livekit webhook: participant_left bad room",
			"room", room.Name, "error", err)
		return
	}

	slog.Info("livekit webhook: participant left",
		"user_id", userID,
		"channel_id", channelID)

	// Clean up if the user left LiveKit without a WS voice_leave (crash, network loss, F5 reload).
	txn := h.begin(userID)
	defer txn.end()
	conns := h.clientsOf(userID)

	if len(conns) > 0 {
		h.webhookLeftCleanupClient(ctx, txn, conns, userID, channelID, joinToken)
	} else if h.voice != nil {
		// The client already disconnected from WS: use a channel-conditional delete so a
		// newer row from a reconnect and rejoin is not wiped. A grace entry parking this
		// exact join dies with its row (deleteRow drops it first).
		h.webhookLeftDeleteRow(ctx, txn, userID, channelID, joinToken, "client gone")
	}
}

// webhookLeftCleanupClient is the still-connected-client stage of
// handleWebhookParticipantLeft: it compare-and-clears the client's voice fields for
// this exact join instance, then finishes the leave or, if the client moved on,
// clears the stale DB row.
func (h *Hub) webhookLeftCleanupClient(ctx context.Context, txn *voiceTxn, conns []*Client, userID, channelID int64, joinToken string) {
	// Atomic compare-and-clear of this exact join instance (channel and token, one slot
	// critical section): a voice_join committed on the readPump goroutine meanwhile (a
	// switch, or a same-channel rejoin with a fresh token) must not be wiped from
	// under the new session along with its VoiceTopic subscription. Only the
	// connection holding the call can match; other devices have an empty slot.
	matched := false
	for _, c := range conns {
		if txn.clearExact(c, channelID, joinToken) {
			matched = true
		}
	}

	if matched {
		h.webhookLeftFinishLeave(ctx, txn, userID, channelID, joinToken)
	} else if h.voice != nil {
		// The client has voiceChID=0 or moved channel (e.g. after F5), or this webhook is
		// for an older join instance.
		h.webhookLeftDeleteRow(ctx, txn, userID, channelID, joinToken, "stale DB row")
	}
}

// webhookLeftDeleteRow is the row-only removal for when no live slot matched this
// join instance (socket gone or moved on): a channel-conditional row delete, key-holder
// re-election and the voice_leave broadcast. deleteRow also drops a grace entry
// parking this exact join, so expireVoiceGrace -> finishVoiceLeave (which would
// have re-elected) never runs; the election here replaces it. A parked member's
// slot was cleared when parked, so it no longer counts in the election scan while
// the key-holder map may still name it. The election runs only when this call
// removed membership: a row was deleted or a grace entry for this exact join
// (channel and token) was dropped, even if the delete failed. A late leave for an
// older join removes neither and must not demote a merely parked holder. The grace
// entry is read before deleteRow takes it, safe because the member lock is held and
// expiry/resume take entries under it. txn is the caller's Hub.begin(userID)
// handle; no hub lock is held.
func (h *Hub) webhookLeftDeleteRow(ctx context.Context, txn *voiceTxn, userID, channelID int64, joinToken, stage string) {
	parked := false
	if e := h.voiceReg.voiceGrace.get(userID); e != nil {
		parked = e.snap.chID == channelID && e.snap.joinToken == joinToken
	}
	deleted, dbErr := txn.deleteRow(ctx, channelID, joinToken)
	if dbErr != nil {
		slog.Error("livekit webhook: LeaveVoiceChannelIfMatch failed",
			"error", dbErr, "stage", stage, "user_id", userID, "channel_id", channelID)
	}
	if parked || deleted {
		h.updateKeyHolder(channelID)
	}
	if dbErr == nil && deleted {
		h.broadcastVoiceEvent(ctx, channelID, userID, buildVoiceLeave(channelID, userID))
		slog.Info("livekit webhook: cleaned stale DB voice row",
			"stage", stage, "user_id", userID, "channel_id", channelID)
	}
}

// webhookLeftFinishLeave is the tear-down stage of webhookLeftCleanupClient, reached
// once the client's voice fields matched and were cleared and unsubscribed: clear
// the DB row, move the E2EE key holder on, broadcast the leave.
func (h *Hub) webhookLeftFinishLeave(ctx context.Context, txn *voiceTxn, userID, channelID int64, joinToken string) {
	if h.voice != nil {
		if err := leaveVoiceChannelWithRetry(ctx, txn, channelID, joinToken); err != nil {
			slog.Error("livekit webhook: LeaveVoiceChannel exhausted retries",
				"error", err, "user_id", userID, "channel_id", channelID)
		}
	}

	// This participant is out of voice, so the key holder may need to move; otherwise
	// the map keeps naming them and the real lowest-uid participant's rekey offers are
	// rejected with NOT_KEY_HOLDER. Safe here: no locks are held.
	h.updateKeyHolder(channelID)

	// The leaver's client state was just cleared, so broadcastVoiceEvent's
	// still-in-the-room union cannot see them; without broadcastVoiceEventWithLeaver's
	// extra term a participant without READ_MESSAGES (voice membership can outlive a
	// READ revocation) never learns the server tore down their call. Mirrors
	// finishVoiceLeave and CleanupVoiceForChannel.
	h.broadcastVoiceEventWithLeaver(ctx, channelID, buildVoiceLeave(channelID, userID), userID)
	slog.Info("livekit webhook: cleaned up stale voice state",
		"user_id", userID,
		"channel_id", channelID)
}
