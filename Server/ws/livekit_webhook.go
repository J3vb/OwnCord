package ws

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
)

// webhookMaxBodyBytes bounds the webhook request body to prevent unbounded
// reads from an unauthenticated caller.
const webhookMaxBodyBytes = 64 * 1024

// NewLiveKitWebhookHandler returns an HTTP handler that processes LiveKit
// webhook events. It synchronises LiveKit room state back into OwnCord's
// voice_states DB — primarily for crash recovery when a participant
// disconnects from LiveKit without sending a WS voice_leave.
//
// Speaker detection is handled client-side via LiveKit's
// RoomEvent.ActiveSpeakersChanged (lower latency than webhooks).
func (h *Hub) NewLiveKitWebhookHandler(apiKey, apiSecret string) http.HandlerFunc {
	// The SDK receiver verifies the token signature AND that the token's sha256
	// claim matches the request body hash, binding verification to the body so
	// a captured token cannot be replayed against a forged payload.
	provider := auth.NewSimpleKeyProvider(apiKey, apiSecret)

	return func(w http.ResponseWriter, r *http.Request) {
		// Check Authorization header BEFORE reading the body to avoid
		// allocating memory for unauthenticated requests.
		if r.Header.Get("Authorization") == "" {
			slog.Warn("livekit webhook: missing Authorization header")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Bound the body before the SDK reads it (ReceiveWebhookEvent uses an
		// unbounded io.ReadAll internally).
		r.Body = http.MaxBytesReader(w, r.Body, webhookMaxBodyBytes)

		// ReceiveWebhookEvent verifies the JWT signature, the token's body-hash
		// claim, and the exp/nbf claims, then parses the payload. This replaces
		// the previous manual ParseAPIToken/Verify sequence, which was not bound
		// to the request body (forgery/replay).
		event, err := webhook.ReceiveWebhookEvent(r, provider)
		if err != nil {
			slog.Warn("livekit webhook: verification failed", "error", err)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		slog.Info("livekit webhook received",
			"event", event.Event,
			"room", event.GetRoom().GetName(),
			"participant", event.GetParticipant().GetIdentity(),
		)

		switch event.Event {
		case "participant_joined":
			h.handleWebhookParticipantJoined(r.Context(), event)
		case "participant_left":
			h.handleWebhookParticipantLeft(r.Context(), event)
		default:
			slog.Debug("livekit webhook: unhandled event", "event", event.Event)
		}

		w.WriteHeader(http.StatusOK)
	}
}

// parseParticipantIdentity extracts a user ID and optional join token from a
// LiveKit participant identity formatted as "user-{id}" or
// "user-{id}:{joinToken}".
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

// parseRoomChannelID extracts a channel ID from a LiveKit room name
// formatted as "channel-{id}".
func parseRoomChannelID(roomName string) (int64, error) {
	if !strings.HasPrefix(roomName, "channel-") {
		return 0, fmt.Errorf("invalid room name format: %s", roomName)
	}
	return strconv.ParseInt(roomName[8:], 10, 64)
}

func (h *Hub) handleWebhookParticipantJoined(_ context.Context, event *livekit.WebhookEvent) {
	p := event.GetParticipant()
	room := event.GetRoom()
	if p == nil || room == nil {
		return
	}

	userID, joinToken, err := parseParticipantIdentity(p.Identity)
	if err != nil {
		slog.Warn("livekit webhook: participant_joined bad identity",
			"identity", p.Identity, "error", err)
		return
	}

	channelID, err := parseRoomChannelID(room.Name)
	if err != nil {
		slog.Warn("livekit webhook: participant_joined bad room",
			"room", room.Name, "error", err)
		return
	}

	slog.Info("livekit webhook: participant joined",
		"user_id", userID,
		"channel_id", channelID,
		"room", room.Name)

	// Validate that the participant has a matching voice_states row (BUG-127).
	// A replayed token from a previous session will not have a matching row,
	// so we remove the rogue participant from LiveKit.
	if h.db != nil {
		state, stateErr := h.db.GetVoiceState(userID)
		if stateErr != nil || state == nil || state.ChannelID != channelID {
			slog.Warn("livekit webhook: rogue participant_joined — no matching voice state, removing",
				"user_id", userID, "channel_id", channelID)
			if h.livekit != nil {
				if rmErr := h.livekit.RemoveParticipant(channelID, userID, joinToken); rmErr != nil { //nolint:contextcheck // RemoveParticipant manages its own timeout context
					slog.Error("livekit webhook: failed to remove rogue participant",
						"error", rmErr, "user_id", userID, "channel_id", channelID)
				}
			}
			return
		}
		// Verify join token matches to prevent token replay from old sessions.
		if joinToken != "" && state.JoinedAt != joinToken {
			slog.Warn("livekit webhook: stale join token on participant_joined, removing",
				"user_id", userID, "channel_id", channelID,
				"expected_token", state.JoinedAt, "got_token", joinToken)
			if h.livekit != nil {
				if rmErr := h.livekit.RemoveParticipant(channelID, userID, joinToken); rmErr != nil { //nolint:contextcheck // RemoveParticipant manages its own timeout context
					slog.Error("livekit webhook: failed to remove stale participant",
						"error", rmErr, "user_id", userID, "channel_id", channelID)
				}
			}
			return
		}
	}
}

func (h *Hub) handleWebhookParticipantLeft(ctx context.Context, event *livekit.WebhookEvent) {
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

	// Clean up voice state if the user disconnected from LiveKit
	// without sending a WS voice_leave (e.g. crash, network loss, F5 reload).
	h.mu.RLock()
	c, exists := h.clients[userID]
	h.mu.RUnlock()

	if exists {
		currentChID, currentJoinToken := c.getVoiceState()
		if currentChID == channelID && currentJoinToken != "" && currentJoinToken == joinToken {
			// Double-check voice state to guard against a concurrent voice_join
			// that updated the state between the read above and clearVoiceState (L8).
			if reChID, reJT := c.getVoiceState(); reChID == channelID && reJT == joinToken {
				c.clearVoiceState()

				if h.db != nil {
					if err := leaveVoiceChannelWithRetry(ctx, h, userID, channelID, joinToken); err != nil {
						slog.Error("livekit webhook: LeaveVoiceChannel exhausted retries",
							"error", err, "user_id", userID, "channel_id", channelID)
					}
				}

				h.BroadcastToAll(buildVoiceLeave(channelID, userID))
				slog.Info("livekit webhook: cleaned up stale voice state",
					"user_id", userID,
					"channel_id", channelID)
			}
		} else if h.db != nil {
			// Client has voiceChID=0 or moved to a different channel (e.g.
			// after F5 reload), or this webhook is for an older join instance.
			deleted, dbErr := h.db.LeaveVoiceChannelIfMatch(userID, channelID, joinToken)
			if dbErr != nil {
				slog.Error("livekit webhook: LeaveVoiceChannelIfMatch failed (stale DB row)",
					"error", dbErr, "user_id", userID, "channel_id", channelID)
			} else if deleted {
				h.BroadcastToAll(buildVoiceLeave(channelID, userID))
				slog.Info("livekit webhook: cleaned stale DB voice row after reconnect",
					"user_id", userID, "channel_id", channelID)
			}
		}
	} else if h.db != nil {
		// Client already disconnected from WS — use channel-conditional delete
		// to avoid wiping a newer row if the user reconnected and rejoined.
		deleted, dbErr := h.db.LeaveVoiceChannelIfMatch(userID, channelID, joinToken)
		if dbErr != nil {
			slog.Error("livekit webhook: LeaveVoiceChannelIfMatch failed (client gone)",
				"error", dbErr, "user_id", userID, "channel_id", channelID)
		} else if deleted {
			h.BroadcastToAll(buildVoiceLeave(channelID, userID))
		}
	}
}

// MountWebhookRoute is a helper for the router to mount the webhook endpoint.
func MountWebhookRoute(h *Hub, apiKey, apiSecret string) http.HandlerFunc {
	return h.NewLiveKitWebhookHandler(apiKey, apiSecret)
}
