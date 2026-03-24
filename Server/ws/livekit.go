// Package ws provides the LiveKit integration client.
//
// LiveKitClient wraps the LiveKit server SDK for token generation and
// room management. It is the primary interface between OwnCord's WS
// handlers and the LiveKit server.
package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/owncord/server/config"
)

// tokenTTL is the validity duration for generated LiveKit access tokens.
// Kept at 4h to limit exposure if a token is leaked — there is no server-side
// revocation for LiveKit JWTs. The client can request a refresh via
// voice_token_refresh before expiry.
const tokenTTL = 4 * time.Hour

// LiveKitClient provides token generation and room management via
// the LiveKit server SDK.
type LiveKitClient struct {
	apiKey    string
	apiSecret string
	url       string
	roomSvc   *lksdk.RoomServiceClient
}

// NewLiveKitClient creates a new LiveKit client from the voice config.
// Returns an error if the credentials are missing or still set to the
// well-known default dev values (which are public in the source code).
func NewLiveKitClient(cfg *config.VoiceConfig) (*LiveKitClient, error) {
	if cfg.LiveKitAPIKey == "" || cfg.LiveKitAPISecret == "" {
		return nil, fmt.Errorf("livekit: api_key and api_secret are required")
	}
	if cfg.LiveKitURL == "" {
		return nil, fmt.Errorf("livekit: url is required")
	}
	if config.IsDefaultVoiceCredentials(cfg) {
		return nil, fmt.Errorf("livekit: refusing to start with default dev credentials — set voice.livekit_api_key and voice.livekit_api_secret in config.yaml")
	}

	// LiveKit room service client uses the HTTP URL (not WS).
	// Convert ws:// to http:// and wss:// to https:// for the REST API.
	httpURL := wsToHTTP(cfg.LiveKitURL)

	roomSvc := lksdk.NewRoomServiceClient(httpURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret)

	slog.Info("livekit: client initialized",
		"url", cfg.LiveKitURL,
		"http_url", httpURL)

	return &LiveKitClient{
		apiKey:    cfg.LiveKitAPIKey,
		apiSecret: cfg.LiveKitAPISecret,
		url:       cfg.LiveKitURL,
		roomSvc:   roomSvc,
	}, nil
}

// RoomName returns the LiveKit room name for an OwnCord channel.
func RoomName(channelID int64) string {
	return fmt.Sprintf("channel-%d", channelID)
}

// GenerateToken creates a LiveKit access token for the given user
// to join the specified channel's voice room.
func (c *LiveKitClient) GenerateToken(
	userID int64,
	username string,
	channelID int64,
	canPublish bool,
	canSubscribe bool,
) (string, error) {
	roomName := RoomName(channelID)
	identity := fmt.Sprintf("user-%d", userID)

	at := auth.NewAccessToken(c.apiKey, c.apiSecret)
	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           roomName,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublish, // data channel follows publish permission
	}
	at.SetVideoGrant(grant).
		SetIdentity(identity).
		SetName(username).
		SetValidFor(tokenTTL)

	token, err := at.ToJWT()
	if err != nil {
		return "", fmt.Errorf("livekit: generating token: %w", err)
	}

	slog.Debug("livekit: generated token",
		"identity", identity,
		"room", roomName,
		"can_publish", canPublish)

	return token, nil
}

// URL returns the LiveKit WebSocket URL for client connections.
func (c *LiveKitClient) URL() string {
	return c.url
}

// lkTimeout is the maximum duration for LiveKit SDK calls (remove, list, etc.).
const lkTimeout = 5 * time.Second

// RemoveParticipant forcefully disconnects a participant from a room.
func (c *LiveKitClient) RemoveParticipant(channelID int64, userID int64) error {
	roomName := RoomName(channelID)
	identity := fmt.Sprintf("user-%d", userID)

	ctx, cancel := context.WithTimeout(context.Background(), lkTimeout)
	defer cancel()
	_, err := c.roomSvc.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room:     roomName,
		Identity: identity,
	})
	if err != nil {
		return fmt.Errorf("livekit: removing participant %s from %s: %w", identity, roomName, err)
	}

	slog.Info("livekit: removed participant",
		"identity", identity,
		"room", roomName)
	return nil
}

// ListParticipants returns all participants in a channel's voice room.
func (c *LiveKitClient) ListParticipants(channelID int64) ([]*livekit.ParticipantInfo, error) {
	roomName := RoomName(channelID)

	ctx, cancel := context.WithTimeout(context.Background(), lkTimeout)
	defer cancel()
	resp, err := c.roomSvc.ListParticipants(ctx, &livekit.ListParticipantsRequest{
		Room: roomName,
	})
	if err != nil {
		return nil, fmt.Errorf("livekit: listing participants in %s: %w", roomName, err)
	}

	return resp.Participants, nil
}

// CountVideoTracks returns the number of video tracks published in a room.
// Used for MaxVideo enforcement.
func (c *LiveKitClient) CountVideoTracks(channelID int64) (int, error) {
	participants, err := c.ListParticipants(channelID)
	if err != nil {
		return 0, err
	}

	count := 0
	for _, p := range participants {
		for _, t := range p.Tracks {
			if t.Type == livekit.TrackType_VIDEO {
				count++
			}
		}
	}
	return count, nil
}

// HealthCheck verifies connectivity to the LiveKit server by listing rooms.
// Returns true if the server responds successfully.
func (c *LiveKitClient) HealthCheck() (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	_, err := c.roomSvc.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return false, fmt.Errorf("livekit health check failed: %w", err)
	}

	return true, nil
}

// wsToHTTP converts a WebSocket URL to an HTTP URL.
func wsToHTTP(wsURL string) string {
	switch {
	case len(wsURL) >= 6 && wsURL[:6] == "wss://":
		return "https://" + wsURL[6:]
	case len(wsURL) >= 5 && wsURL[:5] == "ws://":
		return "http://" + wsURL[5:]
	default:
		return wsURL
	}
}
