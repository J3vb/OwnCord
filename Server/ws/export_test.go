// export_test.go exposes unexported functions and methods for use in external
// test packages (package ws_test). This file is compiled only during "go test".
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/owncord/server/db"
)

// ─── hub sweep helpers ─────────────────────────────────────────────────────

// SweepStaleClientsForTest exposes sweepStaleClients for external tests.
func (h *Hub) SweepStaleClientsForTest() {
	h.sweepStaleClients()
}

// SweepStaleVoiceStatesForTest exposes sweepStaleVoiceStates for external tests.
func (h *Hub) SweepStaleVoiceStatesForTest() {
	h.sweepStaleVoiceStates()
}

// SweepRevokedSessionsForTest exposes sweepRevokedSessions for external tests.
func (h *Hub) SweepRevokedSessionsForTest() {
	h.sweepRevokedSessions()
}

// SetClientLastActivityForTest overwrites a client's lastActivity timestamp.
func SetClientLastActivityForTest(c *Client, t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastActivity = t
}

// ─── client getter/setter helpers ──────────────────────────────────────────

// GetLastActivityForTest exposes Client.getLastActivity for external tests.
func GetLastActivityForTest(c *Client) time.Time {
	return c.getLastActivity()
}

// ClearVoiceChIDForTest exposes Client.clearVoiceChID for external tests.
func ClearVoiceChIDForTest(c *Client) int64 {
	return c.clearVoiceChID()
}

// SetVoiceChIDForTest sets the voice channel ID atomically, clearing the join
// token when leaving (chID 0) — the same contract production keeps via
// setVoiceState. Test-only: production has no set-channel-without-token path.
func SetVoiceChIDForTest(c *Client, chID int64) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = chID
	if chID == 0 {
		c.voiceJoinToken = ""
	}
}

// SetClientVoiceChID is an alias kept for existing tests.
func SetClientVoiceChID(c *Client, channelID int64) {
	SetVoiceChIDForTest(c, channelID)
}

// SetClientVoiceStateForTest sets both the voice channel and join token.
func SetClientVoiceStateForTest(c *Client, channelID int64, joinToken string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = channelID
	c.voiceJoinToken = joinToken
}

// SetClientE2EEPubKeyForTest sets the E2EE public key on a client (no signature).
func SetClientE2EEPubKeyForTest(c *Client, key string) {
	c.setE2EEPubKey(key, "")
}

// GetClientE2EEPubKeyForTest returns the E2EE public key from a client.
func GetClientE2EEPubKeyForTest(c *Client) string {
	key, _ := c.getE2EEPubKey()
	return key
}

// NewTestClient creates a client with a caller-supplied send channel; conn is nil.
func NewTestClient(hub *Hub, userID int64, send chan []byte) *Client {
	return &Client{
		hub:      hub,
		ctx:      context.Background(),
		userID:   userID,
		send:     send,
		sendHigh: send, // unified for test observability
		sendLow:  send,
	}
}

// NewTestClientWithChannel creates a test client subscribed to a specific channel.
func NewTestClientWithChannel(hub *Hub, userID, channelID int64, send chan []byte) *Client {
	return &Client{
		hub:       hub,
		ctx:       context.Background(),
		userID:    userID,
		channelID: channelID,
		send:      send,
		sendHigh:  send, // unified for test observability
		sendLow:   send,
	}
}

// NewTestClientWithUser creates a test client with an authenticated user record
// set. Use this when tests need the client to pass permission checks.
func NewTestClientWithUser(hub *Hub, user *db.User, channelID int64, send chan []byte) *Client {
	return &Client{
		hub:       hub,
		ctx:       context.Background(),
		userID:    user.ID,
		user:      user,
		channelID: channelID,
		send:      send,
		sendHigh:  send, // unified for test observability
		sendLow:   send,
	}
}

// NewTestClientWithTokenHash creates a test client that carries a session token
// hash. Use this when tests need to exercise the periodic session-expiry check.
func NewTestClientWithTokenHash(hub *Hub, user *db.User, tokenHash string, channelID int64, send chan []byte) *Client {
	return &Client{
		hub:       hub,
		ctx:       context.Background(),
		userID:    user.ID,
		user:      user,
		tokenHash: tokenHash,
		channelID: channelID,
		send:      send,
		sendHigh:  send, // unified for test observability
		sendLow:   send,
	}
}

// RunningForTest reports whether the hub's Run loop has started.
func (h *Hub) RunningForTest() bool {
	return h.running.Load()
}

// ClientUserIDForTest returns the client's user ID for external tests.
func ClientUserIDForTest(c *Client) int64 {
	return c.userID
}

// ClientChannelIDForTest returns the client's currently focused channel for
// external tests.
func ClientChannelIDForTest(c *Client) int64 {
	return c.getChannelID()
}

// TouchForTest exposes Client.touch for external tests.
func TouchForTest(c *Client) {
	c.touch()
}

// RollbackVoiceJoinForTest exposes Hub.rollbackVoiceJoin for external tests.
func (h *Hub) RollbackVoiceJoinForTest(c *Client, channelID int64) {
	h.rollbackVoiceJoin(context.Background(), c, channelID, true)
}

// LeaveVoiceChannelWithRetryForTest exposes leaveVoiceChannelWithRetry for external tests.
func LeaveVoiceChannelWithRetryForTest(h *Hub, userID int64, channelID int64, joinToken string) error {
	return leaveVoiceChannelWithRetry(context.Background(), h, userID, channelID, joinToken)
}

// ─── livekit process/webhook helpers ───────────────────────────────────────

// GenerateConfigForTest exposes LiveKitProcess.generateConfig for external tests.
func (p *LiveKitProcess) GenerateConfigForTest() (string, error) {
	return p.generateConfig()
}

// SetProcessCmdForTest sets cmd to a non-nil value to simulate "already running".
func (p *LiveKitProcess) SetProcessCmdForTest() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cmd = &exec.Cmd{}
}

// SetProcessStoppedForTest sets stopped=true to simulate a stopped process.
func (p *LiveKitProcess) SetProcessStoppedForTest() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stopped = true
}

// NewHubForTest creates a minimal Hub with no DB or limiter for webhook testing.
func NewHubForTest() *Hub {
	return &Hub{
		clients:      make(map[int64]*Client),
		pubsub:       NewPubSub(),
		topicLimiter: NewTopicRateLimiter(topicRateLimitPerSecond, time.Second),
	}
}

// PubSubForTest exposes the hub's PubSub for external tests.
func (h *Hub) PubSubForTest() *PubSub {
	return h.pubsub
}

// BuildAuthOKForTest exposes Hub.buildAuthOK for external tests.
// Defaults to replay_source="none" since most callers test the fresh-connect
// path; tests that care about the resume tier can call buildAuthOK directly.
func (h *Hub) BuildAuthOKForTest(user *db.User, roleName string) []byte {
	return h.buildAuthOK(context.Background(), user, roleName, "none")
}

// BuildReadyForTest exposes Hub.buildReady for external tests.
// Passes nil role so no channels are visible (fail-closed, BUG-094).
func (h *Hub) BuildReadyForTest(database *db.DB, userID int64) ([]byte, error) {
	return h.buildReady(context.Background(), database, userID, nil)
}

// BuildReadyWithRoleForTest exposes Hub.buildReady with a role for external tests.
func (h *Hub) BuildReadyWithRoleForTest(database *db.DB, userID int64, role *db.Role) ([]byte, error) {
	return h.buildReady(context.Background(), database, userID, role)
}

// ComputeAllowedChannelsForTest exposes Hub.computeAllowedChannels for external
// tests (the REST/WS channel-visibility agreement test).
func (h *Hub) ComputeAllowedChannelsForTest(database *db.DB, user *db.User) (map[int64]bool, error) {
	return h.computeAllowedChannels(context.Background(), database, user)
}

// GetCachedSettingsForTest exposes Hub.getCachedSettings for external tests.
func (h *Hub) GetCachedSettingsForTest() (string, string) {
	return h.getCachedSettings(context.Background())
}

// GetClientVoiceChIDForTest exposes Client.getVoiceChID for external tests.
func GetClientVoiceChIDForTest(c *Client) int64 {
	return c.getVoiceChID()
}

// GetClientVoiceJoinTokenForTest reads the join token under voiceMu.
func GetClientVoiceJoinTokenForTest(c *Client) string {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.voiceJoinToken
}

// ExpireSettingsCacheForTest forces the settings cache to appear stale so that
// the next call to getCachedSettings triggers a DB refresh.
func (h *Hub) ExpireSettingsCacheForTest() {
	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	h.settingsLastUpdate = time.Time{} // zero time — always older than any TTL
}

// ParseChannelIDForTest exposes parseChannelID for external tests.
func ParseChannelIDForTest(payload json.RawMessage) (int64, error) {
	return parseChannelID(payload)
}

// BuildJSONForTest exposes buildJSON for external tests.
func BuildJSONForTest(v any) []byte {
	return buildJSON(v)
}

// ParseIdentityForTest parses a LiveKit participant identity and discards the
// join token, exercising the production parseParticipantIdentity.
func ParseIdentityForTest(identity string) (int64, error) {
	userID, _, err := parseParticipantIdentity(identity)
	return userID, err
}

// ParseParticipantIdentityForTest exposes parseParticipantIdentity for tests.
func ParseParticipantIdentityForTest(identity string) (int64, string, error) {
	return parseParticipantIdentity(identity)
}

// ParseRoomChannelIDForTest exposes parseRoomChannelID for external tests.
func ParseRoomChannelIDForTest(roomName string) (int64, error) {
	return parseRoomChannelID(roomName)
}

// WsToHTTPForTest exposes wsToHTTP for external tests.
func WsToHTTPForTest(wsURL string) string {
	return wsToHTTP(wsURL)
}

// RegisterNowForTest exposes registerNow for external tests so clients are
// visible immediately (no channel round-trip through hub.Run). No channels are
// readable, matching the hub-loop registration path.
func (h *Hub) RegisterNowForTest(c *Client) {
	h.registerNow(c, nil)
}

// RegisterNowWithReadableForTest exposes registerNow with an explicit
// READ_MESSAGES channel set, as the handshake paths in serve.go supply it.
func (h *Hub) RegisterNowWithReadableForTest(c *Client, readableChannelIDs map[int64]bool) {
	h.registerNow(c, readableChannelIDs)
}

// ClearVoiceStateForTest exposes clearVoiceState for external tests.
func (c *Client) ClearVoiceStateForTest() {
	c.clearVoiceState()
}

// QualityBitrateForTest exposes qualityBitrate for external tests.
func QualityBitrateForTest(quality string) int {
	return qualityBitrate(quality)
}

// BuildDMChannelOpenForTest exposes buildDMChannelOpenFor for external tests.
func BuildDMChannelOpenForTest(channelID int64, recipient *db.User) []byte {
	return buildDMChannelOpenFor(channelID, recipient, 0)
}

// BuildDMChannelOpenInfoForTest exposes the group-aware buildDMChannelOpen.
func BuildDMChannelOpenInfoForTest(info db.DMChannelInfo) []byte {
	return buildDMChannelOpen(info)
}

// BuildCallSignalForTest exposes buildCallSignal for external tests.
func BuildCallSignalForTest(msgType string, channelID, fromUserID int64, username string) []byte {
	return buildCallSignal(msgType, channelID, fromUserID, username)
}

// HandleWebhookParticipantLeftForTest exposes handleWebhookParticipantLeft for
// external tests so they can simulate LiveKit webhook events without HTTP.
func (h *Hub) HandleWebhookParticipantLeftForTest(userID int64, channelID int64, joinToken string) {
	identity := fmt.Sprintf("user-%d:%s", userID, joinToken)
	roomName := fmt.Sprintf("channel-%d", channelID)
	event := &livekit.WebhookEvent{
		Event: "participant_left",
		Participant: &livekit.ParticipantInfo{
			Identity: identity,
		},
		Room: &livekit.Room{
			Name: roomName,
		},
	}
	h.handleWebhookParticipantLeft(context.Background(), event)
}

// HandleWebhookParticipantJoinedForTest exposes handleWebhookParticipantJoined
// for external tests. identity and roomName are passed raw so a test can feed
// malformed values through the same parse path a hostile webhook would.
func (h *Hub) HandleWebhookParticipantJoinedForTest(identity, roomName string) {
	event := &livekit.WebhookEvent{
		Event:       "participant_joined",
		Participant: &livekit.ParticipantInfo{Identity: identity},
		Room:        &livekit.Room{Name: roomName},
	}
	h.handleWebhookParticipantJoined(context.Background(), event)
}

// HandleWebhookParticipantJoinedEventForTest exposes
// handleWebhookParticipantJoined with a caller-built event so tests can cover
// the nil-participant and nil-room guards.
func (h *Hub) HandleWebhookParticipantJoinedEventForTest(event *livekit.WebhookEvent) {
	h.handleWebhookParticipantJoined(context.Background(), event)
}

// MustFullResyncForTest exposes mustFullResync for external tests.
func (h *Hub) MustFullResyncForTest(lastSeq uint64) bool {
	return h.mustFullResync(lastSeq)
}

// HasChannelPermForTest exposes Hub.hasChannelPerm for external tests.
func (h *Hub) HasChannelPermForTest(c *Client, channelID, perm int64) bool {
	return h.hasChannelPerm(context.Background(), c, channelID, perm)
}
