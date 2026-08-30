// export_test.go exposes unexported functions and methods for use in external
// test packages (package ws_test). This file is compiled only during "go test".
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/livekit/protocol/livekit"
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

// SubscribedToVoiceTopicForTest reports whether c itself (identity compare,
// not just its userID) holds the subscription to channelID's voice topic.
func (h *Hub) SubscribedToVoiceTopicForTest(c *Client, channelID int64) bool {
	h.pubsub.mu.RLock()
	defer h.pubsub.mu.RUnlock()
	return h.pubsub.topics[VoiceTopic(channelID)][c.userID] == c
}

// SubscribeVoiceTopicForTest subscribes c to channelID's voice topic, as the
// production voice_join flow does.
func (h *Hub) SubscribeVoiceTopicForTest(c *Client, channelID int64) {
	h.pubsub.Subscribe(c, VoiceTopic(channelID))
}

// SubscribedToChannelTopicForTest reports whether c itself (identity compare,
// not just its userID) holds the subscription to channelID's channel topic.
func (h *Hub) SubscribedToChannelTopicForTest(c *Client, channelID int64) bool {
	h.pubsub.mu.RLock()
	defer h.pubsub.mu.RUnlock()
	return h.pubsub.topics[ChannelTopic(channelID)][c.userID] == c
}

// ApplySetChannelIDForTest exposes Hub.applySetChannelID for external tests —
// the SetChannelID applier that channel_focus's handleMessage result runs
// through (subscribe + live re-validate, OC-0024).
func (h *Hub) ApplySetChannelIDForTest(c *Client, newChID int64) {
	h.applySetChannelID(c, newChID)
}

// SetClientVoiceStateForTest sets both the voice channel and join token,
// representing a settled, already-completed voice session — see
// voiceJoinCompleted on Client (OC-0270) — rather than a join still racing
// its own in-flight supersession guards. Callers that specifically need the
// latter (e.g. to exercise those guards, or registerNow's OC-0270 transfer
// gate) must not use this helper; use setVoiceState directly instead.
func SetClientVoiceStateForTest(c *Client, channelID int64, joinToken string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = channelID
	c.voiceJoinToken = joinToken
	c.voiceJoinCompleted = true
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

// RollbackVoiceJoinForTest exposes Hub.rollbackVoiceJoin for external tests,
// exercising the empty-joinedAt (re-read) path.
func (h *Hub) RollbackVoiceJoinForTest(c *Client, channelID int64) {
	h.rollbackVoiceJoin(context.Background(), c, channelID, "", true)
}

// RollbackVoiceJoinWithTokenForTest exposes Hub.rollbackVoiceJoin with an
// explicit join token, for external tests exercising the join-instance-scoped
// delete (OC-0044).
func (h *Hub) RollbackVoiceJoinWithTokenForTest(c *Client, channelID int64, joinedAt string) {
	h.rollbackVoiceJoin(context.Background(), c, channelID, joinedAt, true)
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

// HTTPTransportForTest exposes the health-check client's transport so tests can
// assert it does not share http.DefaultTransport's connection pool.
func (p *LiveKitProcess) HTTPTransportForTest() http.RoundTripper {
	return p.httpClient.Transport
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

// RunMentionCountsInlineForTest makes the hub's MessageService apply mention
// counts synchronously instead of on a background goroutine, so a test can read
// the counts deterministically right after driving a chat_send through the hub.
func (h *Hub) RunMentionCountsInlineForTest() {
	h.messageSvc.RunBackgroundInlineForTest()
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

// PeekClientPendingModFlagsForTest reads the moderator-stash flags
// (pendingModServerMuted/pendingModServerDeafened) without consuming them,
// unlike takePendingModFlags. Lets a test assert what a handler left behind
// without also clearing it out from under a later assertion.
func PeekClientPendingModFlagsForTest(c *Client) (serverMuted, serverDeafened bool) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.pendingModServerMuted, c.pendingModServerDeafened
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
	h.HandleWebhookParticipantLeftWithContextForTest(context.Background(), userID, channelID, joinToken)
}

// HandleWebhookParticipantLeftWithContextForTest is
// HandleWebhookParticipantLeftForTest with a caller-supplied context, so
// external tests can simulate the webhook HTTP handler's request context
// (e.g. already-cancelled, as it would be after the webhook sender hangs up)
// instead of always running with context.Background().
func (h *Hub) HandleWebhookParticipantLeftWithContextForTest(ctx context.Context, userID int64, channelID int64, joinToken string) {
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
	h.handleWebhookParticipantLeft(ctx, event)
}

// HandleWebhookParticipantJoinedForTest exposes handleWebhookParticipantJoined
// for external tests. identity and roomName are passed raw so a test can feed
// malformed values through the same parse path a hostile webhook would.
func (h *Hub) HandleWebhookParticipantJoinedForTest(identity, roomName string) {
	h.HandleWebhookParticipantJoinedWithContextForTest(context.Background(), identity, roomName)
}

// HandleWebhookParticipantJoinedWithContextForTest is
// HandleWebhookParticipantJoinedForTest with a caller-supplied context, so
// external tests can simulate the webhook HTTP handler's request context
// (e.g. already-cancelled, as it would be after the webhook sender hangs up)
// instead of always running with context.Background(). Mirrors
// HandleWebhookParticipantLeftWithContextForTest.
func (h *Hub) HandleWebhookParticipantJoinedWithContextForTest(ctx context.Context, identity, roomName string) {
	event := &livekit.WebhookEvent{
		Event:       "participant_joined",
		Participant: &livekit.ParticipantInfo{Identity: identity},
		Room:        &livekit.Room{Name: roomName},
	}
	h.handleWebhookParticipantJoined(ctx, event)
}

// WebhookMaxBodyBytesForTest exposes the webhook body cap so external tests can
// build a body that is over it without hardcoding the constant twice.
const WebhookMaxBodyBytesForTest = webhookMaxBodyBytes

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

// BroadcastVoiceEventForTest exposes Hub.broadcastVoiceEvent for external
// tests so a load/soak test can drive the channelReadAudience-resolved
// voice_state/voice_leave fan-out directly, without a full LiveKit join
// round-trip.
func (h *Hub) BroadcastVoiceEventForTest(channelID int64, msg []byte) {
	h.broadcastVoiceEvent(context.Background(), channelID, msg)
}

// MaxColdReplayForTest exposes the cold-tier replay row cap so tests can seed
// exactly enough events to hit it.
const MaxColdReplayForTest = maxColdReplay

// ─── hub simulation helpers (hub_sim_test.go, B3-6) ────────────────────────

// NewSimClientForTest builds a headless client the way newClient does for a
// real socket — separate normal/high/low queues and a resume watermark — minus
// the conn. channelID is the auth-frame active_channel_id handleReconnect
// promotes after checking it against the allowed set (0 = none).
func NewSimClientForTest(hub *Hub, user *db.User, channelID int64, lastSeq uint64, send, sendHigh, sendLow chan []byte) *Client {
	return &Client{
		hub:       hub,
		ctx:       context.Background(),
		userID:    user.ID,
		user:      user,
		channelID: channelID,
		lastSeq:   lastSeq,
		send:      send,
		sendHigh:  sendHigh,
		sendLow:   sendLow,
	}
}

// DeliverBroadcastForTest runs deliverBroadcast synchronously on the caller's
// goroutine — the dispatch loop's critical section without the dispatch loop —
// and returns the seq it allocated, or 0 when the topic limiter shed the
// frame. A non-nil recipients selects the visibility-filtered branch
// (voice_state's path). The seq is read off h.seq before and after, so it is
// exact only while the caller is the sole allocator, which the simulation
// guarantees.
func (h *Hub) DeliverBroadcastForTest(channelID int64, recipients []int64, msg []byte) uint64 {
	before := atomic.LoadUint64(&h.seq)
	h.deliverBroadcast(broadcastMsg{channelID: channelID, recipients: recipients, msg: msg})
	if after := atomic.LoadUint64(&h.seq); after != before {
		return after
	}
	return 0
}

// SendSequencedToUsersForTest exposes sendSequencedToUsers (the sequenced DM
// path) and returns the seq it allocated, under the same sole-allocator caveat
// as DeliverBroadcastForTest.
func (h *Hub) SendSequencedToUsersForTest(channelID int64, userIDs []int64, msg []byte) uint64 {
	before := atomic.LoadUint64(&h.seq)
	h.sendSequencedToUsers(channelID, userIDs, msg)
	if after := atomic.LoadUint64(&h.seq); after != before {
		return after
	}
	return 0
}

// ReconnectRegisterForTest exposes reconnectRegister's buffer-tier path: the
// replay snapshot and registerNow inside ONE h.seqMu critical section, exactly
// as handleReconnect runs it. ok=false means the ring no longer covers lastSeq
// and production would fall through to a full ready.
func (h *Hub) ReconnectRegisterForTest(c *Client, lastSeq uint64, allowed map[int64]bool) ([][]byte, bool) {
	return h.reconnectRegister(context.Background(), c, lastSeq, allowed, "buffer", nil, 0)
}

// UnregisterNowForTest exposes unregisterNow; the return is its "replaced"
// verdict (true when a newer connection holds the slot).
func (h *Hub) UnregisterNowForTest(c *Client) bool {
	return h.unregisterNow(c)
}

// SeqForTest reads the hub's monotonic seq counter.
func (h *Hub) SeqForTest() uint64 {
	return atomic.LoadUint64(&h.seq)
}

// IsSendClosedForTest exposes Client.isSendClosed.
func IsSendClosedForTest(c *Client) bool {
	return c.isSendClosed()
}

// CloseSendForTest exposes Client.closeSend, the pump teardown's last step.
func CloseSendForTest(c *Client) {
	c.closeSend()
}

// NewFaultConnForTest builds the fault-injecting frame transport of
// faultconn_test.go over preface (delivered first, e.g. a replay burst) and
// then in (a client's outbound queue; nil for a preface-only source).
func NewFaultConnForTest(seed uint64, sched FaultSchedule, preface [][]byte, in <-chan []byte) *FaultConn {
	return newFaultConn(seed, sched, preface, in)
}
