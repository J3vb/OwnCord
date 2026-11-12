package ws

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"github.com/twitchtv/twirp"
)

const webhookMaxBodyBytes = 64 * 1024

// NewLiveKitWebhookHandler returns the handler for LiveKit webhook events, syncing room state into
// voice_states (mainly crash recovery when a participant leaves LiveKit without a WS voice_leave).
// Speaker detection is client-side.
func (h *Hub) NewLiveKitWebhookHandler(apiKey, apiSecret string) http.HandlerFunc {
	// The SDK receiver verifies the token signature and that its sha256 claim matches the body
	// hash, so a captured token cannot be replayed against a forged payload.
	provider := auth.NewSimpleKeyProvider(apiKey, apiSecret)

	return func(w http.ResponseWriter, r *http.Request) {
		// Check Authorization before reading the body so unauthenticated requests allocate nothing.
		if r.Header.Get("Authorization") == "" {
			slog.Warn("livekit webhook: missing Authorization header")
			httperr.Write(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "unauthorized")
			return
		}

		// Bound the body before the SDK reads it (ReceiveWebhookEvent uses an unbounded
		// io.ReadAll).
		r.Body = http.MaxBytesReader(w, r.Body, webhookMaxBodyBytes)

		// ReceiveWebhookEvent verifies the JWT signature, body-hash claim and exp/nbf, so
		// verification is bound to the body (no forgery or replay).
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
				// LiveKit retries failed deliveries; acknowledging a failed reconciliation loses
				// the only record of a participant with no voice_states row for the DB sweep to
				// find.
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

func parseRoomChannelID(roomName string) (int64, error) {
	if !strings.HasPrefix(roomName, "channel-") {
		return 0, fmt.Errorf("invalid room name format: %s", roomName)
	}
	return strconv.ParseInt(roomName[8:], 10, 64)
}

func (h *Hub) handleWebhookParticipantJoined(ctx context.Context, event *livekit.WebhookEvent) error {
	// Detach from the triggering HTTP request before cleanup, like every sibling teardown path:
	// otherwise LiveKit hanging up mid-request cancels r.Context() and the rogue-participant
	// lookups would skip (a cancelled read looks transient) or fail instead of evicting.
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

	// A replayed token from a previous session has no matching voice_states row: remove the rogue
	// participant from LiveKit.
	if h.voice != nil {
		return h.webhookJoinedEnforceVoiceState(ctx, userID, channelID, joinToken)
	}
	return nil
}

// webhookJoinedEnforceVoiceState removes the participant from the SFU when their row is missing,
// points at another channel or has a different join token. Callers guarantee h.voice != nil.
func (h *Hub) webhookJoinedEnforceVoiceState(ctx context.Context, userID, channelID int64, joinToken string) error {
	state, stateErr := h.voice.State(ctx, userID)
	if stateErr != nil {
		// A transient read failure is not proof of a rogue participant (one bad read would eject a
		// legitimate one): leave them connected but make the webhook retryable, since the DB sweep
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
	// The join token must match, to prevent replay from old sessions.
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
	// A reconnect can reuse a token issued before a mute or permission change: reconcile current
	// grants at the SFU even when the identity matches.
	if err := h.syncVoiceParticipantPermissions(ctx, userID, channelID, joinToken); err != nil && !liveKitParticipantMissing(err) {
		slog.Error("livekit webhook: failed to reconcile participant permissions",
			"error", err, "user_id", userID, "channel_id", channelID)
		return err
	}
	return nil
}

// liveKitParticipantMissing: a participant or room that vanished before an eviction or update needs
// no reconciliation; other SDK errors stay retryable.
func liveKitParticipantMissing(err error) bool {
	var rpcErr twirp.Error
	return errors.As(err, &rpcErr) && rpcErr.Code() == twirp.NotFound
}

func (h *Hub) handleWebhookParticipantLeft(ctx context.Context, event *livekit.WebhookEvent) {
	// Detach from the HTTP request before cleanup: a cancelled r.Context() makes
	// channelReadAudience's GetChannel fail closed to an empty audience and silently drops the
	// voice_leave for readers outside the room (no sweep re-emits it), and fails
	// LeaveVoiceChannelIfMatch's synchronous first attempt.
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

	if h.webhookSessionReplaced(ctx, channelID, p.Identity, p.Sid) {
		slog.Info("livekit webhook: participant_left for a replaced session, identity still in room, keeping voice state",
			"user_id", userID, "channel_id", channelID)
		return
	}

	// Clean up if the user left LiveKit without a WS voice_leave (crash, network loss, reload).
	txn := h.begin(userID)
	defer txn.end()
	conns := h.clientsOf(userID)

	if len(conns) > 0 {
		h.webhookLeftCleanupClient(ctx, txn, conns, userID, channelID, joinToken)
	} else if h.voice != nil {
		// The client already left WS: use a channel-conditional delete so a newer row from a rejoin
		// is not wiped. A grace entry parking this exact join dies with its row.
		h.webhookLeftDeleteRow(ctx, txn, userID, channelID, joinToken, "client gone")
	}
}

// webhookLeftPresenceTimeout bounds the SFU lookup (webhooks queue per room); on expiry the
// teardown proceeds.
const webhookLeftPresenceTimeout = time.Second

// webhookSessionReplaced reports whether the SFU lists the leaving identity under a different
// session id: a same-identity reconnect makes LiveKit post the old session's participant_left
// before the new one joins. The same sid is the departing session itself; an empty event sid
// falls back to identity only. An unavailable SFU or a vanished room reads as not replaced.
func (h *Hub) webhookSessionReplaced(ctx context.Context, channelID int64, identity, leftSID string) bool {
	if h.livekit == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, webhookLeftPresenceTimeout)
	defer cancel()
	sids, err := h.livekit.ListParticipantSIDs(ctx, channelID)
	if err != nil {
		if !liveKitParticipantMissing(err) {
			slog.Warn("livekit webhook: participant_left presence check failed, tearing down",
				"error", err, "channel_id", channelID)
		}
		return false
	}
	listed, ok := sids[identity]
	return ok && (leftSID == "" || listed != leftSID)
}

// webhookLeftCleanupClient is the still-connected-client stage: compare-and-clear the client's
// voice fields for this exact join, then finish the leave or, if the client moved on, clear the
// stale DB row.
func (h *Hub) webhookLeftCleanupClient(ctx context.Context, txn *voiceTxn, conns []*Client, userID, channelID int64, joinToken string) {
	// Atomic compare-and-clear of this exact join instance (channel and token in one slot critical
	// section): a voice_join committed meanwhile on the readPump goroutine (a switch or same-
	// channel rejoin with a fresh token) must not be wiped along with its VoiceTopic subscription.
	// Only the connection holding the call can match.
	matched := false
	for _, c := range conns {
		if txn.clearExact(c, channelID, joinToken) {
			matched = true
		}
	}

	if matched {
		h.webhookLeftFinishLeave(ctx, txn, userID, channelID, joinToken)
	} else if h.voice != nil {
		// The client has voiceChID=0, moved channel, or this webhook is for an older join instance.
		h.webhookLeftDeleteRow(ctx, txn, userID, channelID, joinToken, "stale DB row")
	}
}

// webhookLeftDeleteRow is the row-only removal when no live slot matched this join instance:
// channel-conditional row delete, key-holder re-election and the voice_leave broadcast. deleteRow
// also drops a grace entry parking this exact join, so expireVoiceGrace -> finishVoiceLeave (which
// would re-elect) never runs; the election here replaces it. It runs only when this call removed
// membership (a row deleted or this exact join's grace entry dropped, even if the delete failed): a
// late leave for an older join must not demote a merely parked holder. The grace entry is read
// before deleteRow takes it, safe because the member lock is held. txn is the caller's Hub.begin
// handle; no hub lock is held.
func (h *Hub) webhookLeftDeleteRow(ctx context.Context, txn *voiceTxn, userID, channelID int64, joinToken, stage string) {
	parked := false
	if e := h.voiceHub.reg.voiceGrace.get(userID); e != nil {
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

// webhookLeftFinishLeave is the tear-down stage once the client's voice fields matched and were
// cleared: clear the DB row, move the E2EE key holder on, broadcast the leave.
func (h *Hub) webhookLeftFinishLeave(ctx context.Context, txn *voiceTxn, userID, channelID int64, joinToken string) {
	if h.voice != nil {
		if err := leaveVoiceChannelWithRetry(ctx, txn, channelID, joinToken); err != nil {
			slog.Error("livekit webhook: LeaveVoiceChannel exhausted retries",
				"error", err, "user_id", userID, "channel_id", channelID)
		}
	}

	// The key holder may need to move, or the map keeps naming this participant and the real
	// lowest-uid participant's rekey offers are rejected with NOT_KEY_HOLDER. No locks are held.
	h.updateKeyHolder(channelID)

	// The leaver's client state was just cleared, so broadcastVoiceEvent's still-in-the-room union
	// cannot see them; without broadcastVoiceEventWithLeaver's extra term a participant lacking
	// READ_MESSAGES never learns their call was torn down (mirrors finishVoiceLeave and
	// CleanupVoiceForChannel).
	h.broadcastVoiceEventWithLeaver(ctx, channelID, buildVoiceLeave(channelID, userID), userID)
	slog.Info("livekit webhook: cleaned up stale voice state",
		"user_id", userID,
		"channel_id", channelID)
}
