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

// SetVoiceChIDForTest exposes Client.setVoiceChID for external tests.
func SetVoiceChIDForTest(c *Client, chID int64) {
	c.setVoiceChID(chID)
}

// TouchForTest exposes Client.touch for external tests.
func TouchForTest(c *Client) {
	c.touch()
}

// RollbackVoiceJoinForTest exposes Hub.rollbackVoiceJoin for external tests.
func (h *Hub) RollbackVoiceJoinForTest(c *Client, channelID int64) {
	h.rollbackVoiceJoin(c, channelID, true)
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
		clients: make(map[int64]*Client),
	}
}

// BuildAuthOKForTest exposes Hub.buildAuthOK for external tests.
func (h *Hub) BuildAuthOKForTest(user *db.User, roleName string) []byte {
	return h.buildAuthOK(user, roleName)
}

// BuildReadyForTest exposes Hub.buildReady for external tests.
// Passes nil role so no channels are visible (fail-closed, BUG-094).
func (h *Hub) BuildReadyForTest(database *db.DB, userID int64) ([]byte, error) {
	return h.buildReady(database, userID, nil)
}

// BuildReadyWithRoleForTest exposes Hub.buildReady with a role for external tests.
func (h *Hub) BuildReadyWithRoleForTest(database *db.DB, userID int64, role *db.Role) ([]byte, error) {
	return h.buildReady(database, userID, role)
}

// GetCachedSettingsForTest exposes Hub.getCachedSettings for external tests.
func (h *Hub) GetCachedSettingsForTest() (string, string) {
	return h.getCachedSettings()
}

// GetClientVoiceChIDForTest exposes Client.getVoiceChID for external tests.
func GetClientVoiceChIDForTest(c *Client) int64 {
	return c.getVoiceChID()
}

// GetClientVoiceJoinTokenForTest exposes Client.getVoiceJoinToken.
func GetClientVoiceJoinTokenForTest(c *Client) string {
	return c.getVoiceJoinToken()
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

// ParseIdentityForTest exposes parseIdentity for external tests.
func ParseIdentityForTest(identity string) (int64, error) {
	return parseIdentity(identity)
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
// visible immediately (no channel round-trip through hub.Run).
func (h *Hub) RegisterNowForTest(c *Client) {
	h.registerNow(c)
}

// ClearVoiceStateForTest exposes clearVoiceState for external tests.
func (c *Client) ClearVoiceStateForTest() {
	c.clearVoiceState()
}

// QualityBitrateForTest exposes qualityBitrate for external tests.
func QualityBitrateForTest(quality string) int {
	return qualityBitrate(quality)
}

// BuildDMChannelOpenForTest exposes buildDMChannelOpen for external tests.
func BuildDMChannelOpenForTest(channelID int64, recipient *db.User) []byte {
	return buildDMChannelOpen(channelID, recipient)
}

// BroadcastVoiceStateUpdateForTest exposes broadcastVoiceStateUpdate for external tests.
func (h *Hub) BroadcastVoiceStateUpdateForTest(c *Client) {
	h.broadcastVoiceStateUpdate(c)
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
