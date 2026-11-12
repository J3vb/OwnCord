// Package ws provides the LiveKit integration client: LiveKitClient wraps the
// LiveKit server SDK for token generation and room management.
package ws

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/livekitproc"
)

// tokenTTL is the validity of LiveKit access tokens: short (5 min) to limit the replay window; the
// client refreshes via voice_token_refresh. Tokens are scoped to one room; the server revokes room
// access on ban/kick; the polling reconciler (voice_reconcile.go) and the participant_joined
// webhook remove SFU participants with no voice_states row; CanPublishSources restricts track types
// per permission; the signalling proxy admits a session only for a current join and connects with
// a credential issued at that moment (voice_session_admit.go).
const tokenTTL = 5 * time.Minute

// LiveKitClient provides token generation and room management via the LiveKit server SDK.
type LiveKitClient struct {
	apiKey    string
	apiSecret string
	url       string
	roomSvc   *lksdk.RoomServiceClient

	// restrictData is voice.restrict_data_publishing: when set, no grant carries the right to
	// publish data packets.
	restrictData bool

	// removed holds identities RemoveParticipant removed, kept removed for voiceRemovedWatchWindow
	// by the hub's watch (voice_removed_watch.go).
	removed removedIdentities

	health liveKitHealthCache
}

// NewLiveKitClient creates a client from the voice config; errors if credentials are missing or
// still the public default dev values.
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

	// The room service client uses the HTTP URL (ws:// becomes http://, wss:// https://).
	httpURL := livekitproc.HTTPURL(cfg.LiveKitURL)

	roomSvc := lksdk.NewRoomServiceClient(httpURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret)

	slog.Info("livekit: client initialized",
		"url", cfg.LiveKitURL,
		"http_url", httpURL)

	return &LiveKitClient{
		apiKey:       cfg.LiveKitAPIKey,
		apiSecret:    cfg.LiveKitAPISecret,
		url:          cfg.LiveKitURL,
		roomSvc:      roomSvc,
		restrictData: cfg.RestrictDataPublishing,
	}, nil
}

// canPublishData is the one rule for the data-packet grant, shared by fresh and refreshed tokens
// and live-participant updates so they cannot disagree: data follows the microphone grant unless
// voice.restrict_data_publishing withholds it from everyone.
func (c *LiveKitClient) canPublishData(microphone bool) bool {
	return microphone && !c.restrictData
}

// RoomName returns the LiveKit room name for an OwnCord channel.
func RoomName(channelID int64) string {
	return fmt.Sprintf("channel-%d", channelID)
}

func participantIdentity(userID int64, voiceJoinToken string) string {
	if voiceJoinToken == "" {
		return fmt.Sprintf("user-%d", userID)
	}
	return fmt.Sprintf("user-%d:%s", userID, voiceJoinToken)
}

// GenerateToken creates an access token for userID to join channelID's voice room. canPublish is
// SpeakVoice; canVideo and canScreenShare set the extra CanPublishSources so raw LiveKit cannot
// bypass USE_VIDEO/SHARE_SCREEN.
func (c *LiveKitClient) GenerateToken(
	userID int64,
	username string,
	channelID int64,
	voiceJoinToken string,
	canPublish bool,
	canVideo bool,
	canScreenShare bool,
) (string, error) {
	roomName := RoomName(channelID)
	identity := participantIdentity(userID, voiceJoinToken)

	// Every token grants CanSubscribe: a server-deafened or non-speaking participant must still
	// receive audio and streams.
	canSubscribeAlways := true

	at := auth.NewAccessToken(c.apiKey, c.apiSecret)
	grant := &auth.VideoGrant{
		RoomJoin:     true,
		Room:         roomName,
		CanSubscribe: &canSubscribeAlways,
	}

	// CanPublishSources supersedes CanPublish. SPEAK_VOICE, USE_VIDEO and SHARE_SCREEN are
	// independent bits (an override can deny one yet grant another), so the list is built from all
	// three. CanPublish is a hard deny only when none grant anything, because LiveKit treats
	// CanPublish=false as blocking every source.
	sources := liveKitPublishSources(canPublish, canVideo, canScreenShare)
	if len(sources) > 0 {
		grant.SetCanPublishSources(sources)
	} else {
		grant.CanPublish = &canPublish
	}
	canData := c.canPublishData(canPublish)
	grant.CanPublishData = &canData

	at.SetVideoGrant(grant).
		SetIdentity(identity).
		SetName(username).
		SetValidFor(tokenTTL)

	token, err := at.ToJWT()
	if err != nil {
		return "", fmt.Errorf("livekit: generating token: %w", err)
	}
	c.removed.extend(identity)

	slog.Debug("livekit: generated token",
		"identity", identity,
		"room", roomName,
		"can_publish", canPublish,
		"can_video", canVideo,
		"can_screen_share", canScreenShare)

	return token, nil
}

func liveKitPublishSources(microphone, camera, screenshare bool) []livekit.TrackSource {
	var sources []livekit.TrackSource
	if microphone {
		sources = append(sources, livekit.TrackSource_MICROPHONE)
	}
	if camera {
		sources = append(sources, livekit.TrackSource_CAMERA)
	}
	if screenshare {
		sources = append(sources, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO)
	}
	return sources
}

// updateParticipantPublishing applies current grants to an exact live join; updating permission
// also withdraws tracks whose source is no longer allowed.
func (c *LiveKitClient) updateParticipantPublishing(ctx context.Context, channelID, userID int64, joinToken string, microphone, camera, screenshare bool) error {
	sources := liveKitPublishSources(microphone, camera, screenshare)
	ctx, cancel := context.WithTimeout(ctx, lkTimeout)
	defer cancel()
	_, err := c.roomSvc.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:     RoomName(channelID),
		Identity: participantIdentity(userID, joinToken),
		Permission: &livekit.ParticipantPermission{
			CanSubscribe:      true,
			CanPublish:        len(sources) > 0,
			CanPublishData:    c.canPublishData(microphone),
			CanPublishSources: sources,
		},
	})
	if err != nil {
		return fmt.Errorf("livekit: updating participant publishing: %w", err)
	}
	return nil
}

// URL returns the LiveKit WebSocket URL for client connections.
func (c *LiveKitClient) URL() string {
	return c.url
}

const lkTimeout = 5 * time.Second

// ListParticipants returns the identities in a channel's room for the reconciler. A failure is
// returned, never collapsed to an empty set: "the SFU did not answer" must not read as "the room is
// empty".
func (c *LiveKitClient) ListParticipants(ctx context.Context, channelID int64) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, lkTimeout)
	defer cancel()
	resp, err := c.roomSvc.ListParticipants(ctx, &livekit.ListParticipantsRequest{
		Room: RoomName(channelID),
	})
	if err != nil {
		return nil, fmt.Errorf("livekit: listing participants: %w", err)
	}
	ids := make([]string, 0, len(resp.GetParticipants()))
	for _, p := range resp.GetParticipants() {
		ids = append(ids, p.GetIdentity())
	}
	return ids, nil
}

// ListParticipantSIDs returns identity -> session id for a channel's room. A failure is returned,
// never collapsed to an empty map.
func (c *LiveKitClient) ListParticipantSIDs(ctx context.Context, channelID int64) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, lkTimeout)
	defer cancel()
	resp, err := c.roomSvc.ListParticipants(ctx, &livekit.ListParticipantsRequest{
		Room: RoomName(channelID),
	})
	if err != nil {
		return nil, fmt.Errorf("livekit: listing participants: %w", err)
	}
	sids := make(map[string]string, len(resp.GetParticipants()))
	for _, p := range resp.GetParticipants() {
		sids[p.GetIdentity()] = p.GetSid()
	}
	return sids, nil
}

// ListRoomChannelIDs returns the OwnCord rooms the SFU has open, for the reconciler: a room can
// hold participants after its last voice_states row is gone. Other rooms are skipped.
func (c *LiveKitClient) ListRoomChannelIDs(ctx context.Context) ([]int64, error) {
	ctx, cancel := context.WithTimeout(ctx, lkTimeout)
	defer cancel()
	resp, err := c.roomSvc.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return nil, fmt.Errorf("livekit: listing rooms: %w", err)
	}
	ids := make([]int64, 0, len(resp.GetRooms()))
	for _, r := range resp.GetRooms() {
		if id, err := parseRoomChannelID(r.GetName()); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// RoomUsage counts open rooms and participants, every room included.
func (c *LiveKitClient) RoomUsage(ctx context.Context) (rooms, participants int, err error) {
	ctx, cancel := context.WithTimeout(ctx, lkTimeout)
	defer cancel()
	resp, err := c.roomSvc.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return 0, 0, fmt.Errorf("livekit: listing rooms: %w", err)
	}
	for _, r := range resp.GetRooms() {
		participants += int(r.GetNumParticipants())
	}
	return len(resp.GetRooms()), participants, nil
}

// RemoveParticipant forcefully disconnects a participant and keeps that exact identity out until
// any token minted for it has expired (voice_removed_watch.go).
func (c *LiveKitClient) RemoveParticipant(ctx context.Context, channelID int64, userID int64, voiceJoinToken string) error {
	c.removed.record(channelID, userID, voiceJoinToken, false)
	return c.removeIdentity(ctx, channelID, participantIdentity(userID, voiceJoinToken))
}

// RemoveParticipantAfterOwnLeave is RemoveParticipant for a client-requested leave, kept out on the
// watch's slower own-leave cadence.
func (c *LiveKitClient) RemoveParticipantAfterOwnLeave(ctx context.Context, channelID int64, userID int64, voiceJoinToken string) error {
	c.removed.record(channelID, userID, voiceJoinToken, true)
	return c.removeIdentity(ctx, channelID, participantIdentity(userID, voiceJoinToken))
}

func (c *LiveKitClient) removeIdentity(ctx context.Context, channelID int64, identity string) error {
	roomName := RoomName(channelID)

	ctx, cancel := context.WithTimeout(ctx, lkTimeout)
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

// HealthCheck reports whether the LiveKit server answers a room listing.
func (c *LiveKitClient) HealthCheck(ctx context.Context) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := c.roomSvc.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return false, fmt.Errorf("livekit health check failed: %w", err)
	}

	return true, nil
}

func loopbackURLOrEmpty(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	if host == "localhost" {
		return rawURL
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return rawURL
	}
	return ""
}
