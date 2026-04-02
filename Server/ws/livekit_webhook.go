package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

// NewLiveKitWebhookHandler returns an HTTP handler that processes LiveKit
// webhook events. It synchronises LiveKit room state back into OwnCord's
// voice_states DB — primarily for crash recovery when a participant
// disconnects from LiveKit without sending a WS voice_leave.
//
// Speaker detection is handled client-side via LiveKit's
// RoomEvent.ActiveSpeakersChanged (lower latency than webhooks).
func (h *Hub) NewLiveKitWebhookHandler(apiKey, apiSecret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check Authorization header BEFORE reading the body to avoid
		// allocating memory for unauthenticated requests.
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			slog.Warn("livekit webhook: missing Authorization header")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err != nil {
			slog.Error("livekit webhook: read body failed", "error", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		// LiveKit sends "Bearer <token>" in the Authorization header.
		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
		verifier, err := auth.ParseAPIToken(tokenStr)
		if err != nil {
			slog.Warn("livekit webhook: invalid token", "error", err)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		if verifier.APIKey() != apiKey {
			slog.Warn("livekit webhook: API key mismatch",
				"got", verifier.APIKey(), "want", apiKey)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Verify checks both the HMAC signature and the exp/nbf claims
		// (via jwt.Claims.Validate with Time: time.Now() inside the SDK).
		// Expired tokens are rejected with an error here.
		if _, _, err := verifier.Verify(apiSecret); err != nil {
			slog.Warn("livekit webhook: token verification failed", "error", err)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Parse the webhook event payload.
		var event livekit.WebhookEvent
		if err := json.Unmarshal(body, &event); err != nil {
			slog.Warn("livekit webhook: invalid JSON", "error", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		slog.Info("livekit webhook received",
			"event", event.Event,
			"room", event.GetRoom().GetName(),
			"participant", event.GetParticipant().GetIdentity(),
		)

		switch event.Event {
		case "participant_joined":
			h.handleWebhookParticipantJoined(&event)
		case "participant_left":
			h.handleWebhookParticipantLeft(&event)
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

// parseIdentity extracts a user ID from a LiveKit participant identity.
func parseIdentity(identity string) (int64, error) {
	userID, _, err := parseParticipantIdentity(identity)
	return userID, err
}

// parseRoomChannelID extracts a channel ID from a LiveKit room name
// formatted as "channel-{id}".
func parseRoomChannelID(roomName string) (int64, error) {
	if !strings.HasPrefix(roomName, "channel-") {
		return 0, fmt.Errorf("invalid room name format: %s", roomName)
	}
	return strconv.ParseInt(roomName[8:], 10, 64)
}

func (h *Hub) handleWebhookParticipantJoined(event *livekit.WebhookEvent) {
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
				if rmErr := h.livekit.RemoveParticipant(channelID, userID, joinToken); rmErr != nil {
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
				if rmErr := h.livekit.RemoveParticipant(channelID, userID, joinToken); rmErr != nil {
					slog.Error("livekit webhook: failed to remove stale participant",
						"error", rmErr, "user_id", userID, "channel_id", channelID)
				}
			}
			return
		}
	}
}

func (h *Hub) handleWebhookParticipantLeft(event *livekit.WebhookEvent) {
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
			// Client is still in the channel that fired the webhook — clean up.
			c.clearVoiceState()

			if h.db != nil {
				if err := leaveVoiceChannelWithRetry(context.Background(), h, userID, channelID, joinToken); err != nil {
					slog.Error("livekit webhook: LeaveVoiceChannel exhausted retries",
						"error", err, "user_id", userID, "channel_id", channelID)
				}
			}

			h.BroadcastToAll(buildVoiceLeave(channelID, userID))
			slog.Info("livekit webhook: cleaned up stale voice state",
				"user_id", userID,
				"channel_id", channelID)
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
