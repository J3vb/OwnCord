package ws

import (
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
		body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err != nil {
			slog.Error("livekit webhook: read body failed", "error", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		// Verify the webhook token from the Authorization header.
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			slog.Warn("livekit webhook: missing Authorization header")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
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

// parseIdentity extracts a user ID from a LiveKit participant identity
// formatted as "user-{id}".
func parseIdentity(identity string) (int64, error) {
	if !strings.HasPrefix(identity, "user-") {
		return 0, fmt.Errorf("invalid identity format: %s", identity)
	}
	return strconv.ParseInt(identity[5:], 10, 64)
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
	if p == nil {
		return
	}

	userID, err := parseIdentity(p.Identity)
	if err != nil {
		slog.Warn("livekit webhook: participant_joined bad identity",
			"identity", p.Identity, "error", err)
		return
	}

	slog.Info("livekit webhook: participant joined",
		"user_id", userID,
		"room", event.GetRoom().GetName())

	// State is already persisted by handleVoiceJoin before the token is
	// issued. This webhook confirms the client actually connected.
}

func (h *Hub) handleWebhookParticipantLeft(event *livekit.WebhookEvent) {
	p := event.GetParticipant()
	room := event.GetRoom()
	if p == nil || room == nil {
		return
	}

	userID, err := parseIdentity(p.Identity)
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
	// without sending a WS voice_leave (e.g. crash, network loss).
	h.mu.RLock()
	c, exists := h.clients[userID]
	h.mu.RUnlock()

	if exists {
		// Only clean up if the user is still in the channel that fired the
		// webhook. If they've already moved or left, don't touch their state.
		currentChID := c.getVoiceChID()
		if currentChID == channelID {
			c.clearVoiceChID()

			if h.db != nil {
				if err := h.db.LeaveVoiceChannel(userID); err != nil {
					slog.Error("livekit webhook: LeaveVoiceChannel failed — ghost voice state may persist",
						"error", err, "user_id", userID, "channel_id", channelID)
				}
			}

			h.BroadcastToAll(buildVoiceLeave(channelID, userID))
			slog.Info("livekit webhook: cleaned up stale voice state",
				"user_id", userID,
				"channel_id", channelID)
		}
	} else {
		// Client already disconnected from WS — ensure DB is clean.
		if h.db != nil {
			if err := h.db.LeaveVoiceChannel(userID); err != nil {
				slog.Error("livekit webhook: LeaveVoiceChannel failed (client gone) — ghost voice state may persist",
					"error", err, "user_id", userID)
			}
		}
	}
}

// MountWebhookRoute is a helper for the router to mount the webhook endpoint.
func MountWebhookRoute(h *Hub, apiKey, apiSecret string) http.HandlerFunc {
	return h.NewLiveKitWebhookHandler(apiKey, apiSecret)
}
