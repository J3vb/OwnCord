// export_test.go exposes unexported functions and methods for use in external
// test packages (package ws_test). This file is compiled only during "go test".
package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/livekit/protocol/livekit"
)

// SetVoiceRejoinBlockWindowForTest shrinks the moderator-removal rejoin block
// for the test's duration.
func SetVoiceRejoinBlockWindowForTest(t interface{ Cleanup(func()) }, d time.Duration) {
	prev := voiceRejoinBlockWindow
	voiceRejoinBlockWindow = d
	t.Cleanup(func() { voiceRejoinBlockWindow = prev })
}

// ─── hub sweep helpers ─────────────────────────────────────────────────────

// SweepStaleClientsForTest exposes sweepStaleClients for external tests.
func (h *Hub) SweepStaleClientsForTest() {
	h.sweepStaleClients()
}

// SweepStaleVoiceStatesForTest exposes sweepStaleVoiceStates for external tests.
func (h *Hub) SweepStaleVoiceStatesForTest() {
	h.sweepStaleVoiceStates(context.Background())
}

// SweepRevokedSessionsForTest exposes sweepRevokedSessions for external tests.
func (h *Hub) SweepRevokedSessionsForTest() {
	h.sweepRevokedSessions(context.Background())
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

// SetVoiceChIDForTest sets the voice channel ID atomically, clearing the join
// token when leaving (chID 0) — the same contract production keeps via
// setVoiceState. Test-only: production has no set-channel-without-token path.
func SetVoiceChIDForTest(c *Client, chID int64) {
	c.voice.voiceMu.Lock()
	defer c.voice.voiceMu.Unlock()
	c.voice.voiceChID = chID
	if chID == 0 {
		c.voice.voiceJoinToken = ""
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
	_, ok := h.pubsub.topics[VoiceTopic(channelID)][c]
	return ok
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
	_, ok := h.pubsub.topics[ChannelTopic(channelID)][c]
	return ok
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
	c.voice.voiceMu.Lock()
	defer c.voice.voiceMu.Unlock()
	c.voice.voiceChID = channelID
	c.voice.voiceJoinToken = joinToken
	c.voice.voiceJoinCompleted = true
}

// SetClientE2EEPubKeyForTest sets the E2EE public key on a client (no signature).
func SetClientE2EEPubKeyForTest(c *Client, key string) {
	c.setE2EEAnnounce(e2eeAnnounce{key: key})
}

// GetClientE2EEPubKeyForTest returns the E2EE public key from a client.
func GetClientE2EEPubKeyForTest(c *Client) string {
	return c.getE2EEAnnounce().key
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
	h.rollbackVoiceJoinTest(context.Background(), c, channelID, "", true)
}

// RollbackVoiceJoinWithTokenForTest exposes Hub.rollbackVoiceJoin with an
// explicit join token, for external tests exercising the join-instance-scoped
// delete (OC-0044).
func (h *Hub) RollbackVoiceJoinWithTokenForTest(c *Client, channelID int64, joinedAt string) {
	h.rollbackVoiceJoinTest(context.Background(), c, channelID, joinedAt, true)
}

// LeaveVoiceChannelWithRetryForTest exposes leaveVoiceChannelWithRetry for external tests.
func LeaveVoiceChannelWithRetryForTest(h *Hub, userID int64, channelID int64, joinToken string) error {
	return h.leaveVoiceChannelWithRetryTest(context.Background(), userID, channelID, joinToken)
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

// NewHubForTest creates a minimal Hub with no DB for webhook testing. limiter
// is real (not nil): deliverBroadcast's channel-scoped path consults it for
// the topic rate limit unconditionally.
func NewHubForTest() *Hub {
	return &Hub{
		clients:  make(map[int64][]*Client),
		pubsub:   NewPubSub(),
		limiter:  auth.NewRateLimiter(),
		voiceMod: newUserLocks[lockRankVoiceMod](),
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
	return h.buildAuthOK(context.Background(), user, roleName, nil, "none")
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
	return h.readyBytes(database, userID, nil)
}

// BuildReadyWithRoleForTest exposes Hub.buildReady with a role for external tests.
func (h *Hub) BuildReadyWithRoleForTest(database *db.DB, userID int64, role *db.Role) ([]byte, error) {
	return h.readyBytes(database, userID, role)
}

// BuildReadyWithReaderForTest exposes Hub.buildReady over any snapshot reader,
// so a test can count or stall its reads.
func (h *Hub) BuildReadyWithReaderForTest(database ReadySnapshotReader, userID int64) ([]byte, error) {
	return h.readyBytes(database, userID, nil)
}

func (h *Hub) readyBytes(database ReadySnapshotReader, userID int64, role *db.Role) ([]byte, error) {
	var buf bytes.Buffer
	if err := h.WriteReadyForTest(database, userID, role, &buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// WriteReadyForTest emits userID's ready payload to w as the handshake
// emits it to the socket, so a test can measure the whole emit.
func (h *Hub) WriteReadyForTest(database ReadySnapshotReader, userID int64, role *db.Role, w io.Writer) error {
	ready, err := h.buildReady(context.Background(), database, userID, role, clientFeatures{})
	if err != nil {
		return err
	}
	_, err = h.writeReady(w, ready)
	return err
}

// LegacyReadyForTest encodes userID's ready as it was before P5-O01: one
// json.Marshal of a map, members included, so a golden test can hold the
// streamed frame to it byte for byte.
func (h *Hub) LegacyReadyForTest(database ReadySnapshotReader, userID int64, role *db.Role) ([]byte, error) {
	f, err := h.readReady(context.Background(), database, userID, role, clientFeatures{})
	if err != nil {
		return nil, err
	}
	members := make([]db.MemberSummary, 0, len(f.roster.members))
	for _, m := range h.presentableMembers(f.roster.members, userID) {
		members = append(members, m)
	}
	payload := map[string]any{
		"activities":      f.head.Activities,
		"listening":       f.head.Listening,
		"capabilities":    f.head.Capabilities,
		"channels":        f.head.Channels,
		"member_timeouts": f.head.MemberTimeouts,
		"members":         members,
		"voice_states":    f.tail.VoiceStates,
		"roles":           f.tail.Roles,
		"dm_channels":     f.head.DMChannels,
		"server_name":     f.tail.ServerName,
		"motd":            f.tail.MOTD,
		"notices":         f.tail.Notices,
	}
	if f.head.Categories != nil {
		payload["categories"] = f.head.Categories
	}
	return buildJSON(map[string]any{
		"type":    MsgTypeReady,
		"payload": payload,
	}), nil
}

// ApplyConnectStatusForTest runs the handshake's connect-status stamp for c.
func (h *Hub) ApplyConnectStatusForTest(c *Client) {
	h.applyConnectStatus(context.Background(), c)
}

// ComputeAllowedChannelsForTest exposes Hub.computeAllowedChannels for external
// tests (the REST/WS channel-visibility agreement test).
func (h *Hub) ComputeAllowedChannelsForTest(database *db.DB, user *db.User) (map[int64]bool, error) {
	return h.computeAllowedChannels(context.Background(), database, user)
}

// ComputeReadableChannelsForTest exposes Hub.computeReadableChannels for
// external tests (the REST/WS/replay READABILITY agreement test, B5-7's
// parallel to the visibility one above).
func (h *Hub) ComputeReadableChannelsForTest(database *db.DB, user *db.User, allowed map[int64]bool) (map[int64]bool, error) {
	return h.computeReadableChannels(context.Background(), database, user, allowed)
}

// GetCachedSettingsForTest exposes Hub.getCachedSettings for external tests.
func (h *Hub) GetCachedSettingsForTest() (string, string) {
	return h.getCachedSettings(context.Background())
}

// GetClientVoiceChIDForTest exposes Client.getVoiceChID for external tests.
func GetClientVoiceChIDForTest(c *Client) int64 {
	return c.voice.channel()
}

// GetClientVoiceJoinTokenForTest reads the join token under voiceMu.
func GetClientVoiceJoinTokenForTest(c *Client) string {
	c.voice.voiceMu.Lock()
	defer c.voice.voiceMu.Unlock()
	return c.voice.voiceJoinToken
}

// PeekClientPendingModFlagsForTest reads the moderator-stash flags
// (pendingModServerMuted/pendingModServerDeafened) without consuming them,
// unlike takePendingModFlags. Lets a test assert what a handler left behind
// without also clearing it out from under a later assertion.
func PeekClientPendingModFlagsForTest(c *Client) (serverMuted, serverDeafened bool) {
	c.voice.voiceMu.Lock()
	defer c.voice.voiceMu.Unlock()
	return c.voice.pendingModServerMuted, c.voice.pendingModServerDeafened
}

// ExpireSettingsCacheForTest forces the settings cache to appear stale so that
// the next call to getCachedSettings triggers a DB refresh.
func (h *Hub) ExpireSettingsCacheForTest() {
	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	h.settingsLastUpdate = time.Time{} // zero time — always older than any TTL
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
	h.registerNowTest(c, nil)
}

// RegisterNowWithReadableForTest exposes registerNow with an explicit
// READ_MESSAGES channel set, as the handshake paths in serve.go supply it.
func (h *Hub) RegisterNowWithReadableForTest(c *Client, readableChannelIDs map[int64]bool) {
	h.registerNowTest(c, readableChannelIDs)
}

// ClearVoiceStateForTest exposes clearVoiceState for external tests.
func (c *Client) ClearVoiceStateForTest() {
	c.voice.clearState()
}

// QualityBitrateForTest exposes qualityBitrate for external tests.
func QualityBitrateForTest(quality string) int {
	return qualityBitrate(quality)
}

// BuildDMChannelOpenForTest exposes buildDMChannelOpenFor for external tests,
// with every participant connected and online.
func BuildDMChannelOpenForTest(channelID int64, recipient *db.User) []byte {
	return buildDMChannelOpenFor(channelID, recipient, 0, func(int64) string { return db.StatusOnline }, nil)
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

// BroadcastVoiceEventForTest exposes Hub.broadcastVoiceEvent for external
// tests so a load/soak test can drive the channelReadAudience-resolved
// voice_state/voice_leave fan-out directly, without a full LiveKit join
// round-trip.
func (h *Hub) BroadcastVoiceEventForTest(channelID, subjectID int64, msg []byte) {
	h.broadcastVoiceEvent(context.Background(), channelID, subjectID, msg)
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
	events, ok := h.reconnectRegister(context.Background(), c, lastSeq, allowed, allowed, "buffer", nil, 0)
	return events, ok
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
// then in (a client's outbound queue; nil for a preface-only source). seed
// and stream are the PCG's two words.
func NewFaultConnForTest(seed, stream uint64, sched FaultSchedule, preface [][]byte, in <-chan []byte) *FaultConn {
	return newFaultConn(seed, stream, sched, preface, in)
}

// EventNamesUserForTest exposes eventNamesUser to the external test package.
func EventNamesUserForTest(data []byte, userID int64) bool { return eventNamesUser(data, userID) }

// EventNamesMessageForTest exposes eventNamesMessage to the external test
// package.
func EventNamesMessageForTest(data []byte, ids map[int64]struct{}) bool {
	return eventNamesMessage(data, ids)
}

// AllFramesForTest returns every frame still held in the ring buffer, oldest
// first, including the oldest slot EventsSince can never return.
func (rb *EventRingBuffer) AllFramesForTest() [][]byte {
	rb.mu.RLock()
	defer rb.mu.RUnlock()
	out := make([][]byte, 0, rb.count)
	for i := 0; i < rb.count; i++ {
		idx := (rb.pos - rb.count + rb.size + i) % rb.size
		if rb.entries[idx].data != nil {
			out = append(out, rb.entries[idx].data)
		}
	}
	return out
}

// CurrentSeqForTest returns the hub's sequence counter.
func (h *Hub) CurrentSeqForTest() uint64 { return atomic.LoadUint64(&h.seq) }

// DropSocketForTest runs readPump's teardown for c after its socket drops:
// unregister, then the voice step, which parks a completed membership in the
// RT-8 grace window.
func (h *Hub) DropSocketForTest(c *Client) {
	chID := c.voice.channel()
	if !h.unregisterNow(c) && chID != 0 {
		h.leaveVoiceOnDisconnect(context.Background(), c, voiceLeaveReasonDisconnect)
	}
}

// leaveVoiceOnDisconnect runs disconnectVoice for a test that drives the
// socket-teardown voice step directly: it takes the member lock the pumps hold
// around the real call.
func (h *Hub) leaveVoiceOnDisconnect(ctx context.Context, c *Client, reason string) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.disconnectVoice(ctx, txn, c, reason)
}

// NoteChannelActivityForTest records a send with the channel_activity
// coalescer, as the emit step of a chat_send does.
func (h *Hub) NoteChannelActivityForTest(channelID, msgID, authorID int64) {
	h.activity.note(activityNote{channelID: channelID, msgID: msgID, authorID: authorID})
}

// FlushChannelActivityNowForTest flushes the pending channel_activity window
// regardless of the throttle. It serializes with the worker's own flush, so
// when it returns every frame for the notes made before the call is queued.
func (h *Hub) FlushChannelActivityNowForTest() {
	h.flushChannelActivity(context.Background())
}

// BuildChatSendOKForTest exposes buildChatSendOK for external tests.
func BuildChatSendOKForTest(requestID string, msgID int64, timestamp, clientMessageID string, duplicate bool, skipped []string) []byte {
	return buildChatSendOK(requestID, msgID, timestamp, clientMessageID, duplicate, skipped)
}

// SetLivePresenceForTest records c's live presence as a connect stamp or
// presence_update would.
func SetLivePresenceForTest(c *Client, status string, customStatus *string, expiresAt string) {
	c.setLivePresence(status, customStatus, expiresAt)
}

// The wrappers below take the voice membership lock the way the production
// callers do, then call the txn-taking function. A test that already holds a
// handle passes it to the real function instead.

func (h *Hub) registerNowTest(c *Client, readableChannelIDs map[int64]bool) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.registerNow(c, readableChannelIDs, txn)
}

func (h *Hub) handleVoiceLeaveTest(ctx context.Context, c *Client, reason string) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.handleVoiceLeave(ctx, txn, c, reason)
}

func (h *Hub) handleVoiceLeaveIfStillInTest(ctx context.Context, c *Client, chID int64, reason string) bool {
	txn := h.begin(c.userID)
	defer txn.end()
	return h.handleVoiceLeaveIfStillIn(ctx, txn, c, chID, reason)
}

func (h *Hub) finishVoiceLeaveTest(ctx context.Context, c *Client, oldChID int64, oldJoinToken, reason string) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.finishVoiceLeave(ctx, txn, c, oldChID, oldJoinToken, reason)
}

func (h *Hub) freshConnectCleanStaleVoiceTest(ctx context.Context, c *Client, vs *db.VoiceState) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.freshConnectCleanStaleVoice(ctx, txn, c, vs)
}

func (h *Hub) rollbackVoiceJoinTest(ctx context.Context, c *Client, channelID int64, joinedAt string, broadcast bool) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.rollbackVoiceJoin(ctx, txn, c, channelID, joinedAt, broadcast)
}

func (h *Hub) voiceJoinGrantTokenTest(ctx context.Context, c *Client, channelID int64, state *db.VoiceState, reqID string) bool {
	txn := h.begin(c.userID)
	defer txn.end()
	return h.voiceJoinGrantToken(ctx, txn, c, channelID, false, state, reqID)
}

func (h *Hub) leaveParkedVoiceTest(ctx context.Context, userID int64, e *voiceGraceEntry, reason string) bool {
	txn := h.begin(userID)
	defer txn.end()
	return h.leaveParkedVoice(ctx, txn, e, reason)
}

func (h *Hub) leaveVoiceChannelWithRetryTest(ctx context.Context, userID, channelID int64, joinToken string) error {
	txn := h.begin(userID)
	defer txn.end()
	return leaveVoiceChannelWithRetry(ctx, txn, channelID, joinToken)
}

// ─── per-frame command deadline (WP 4.1b) ──────────────────────────────────

// SetCommandDeadlineForTest overrides the per-frame deadline for the test's
// duration.
func SetCommandDeadlineForTest(t interface{ Cleanup(func()) }, d time.Duration) {
	prev := wsCommandDeadline.Swap(int64(d))
	t.Cleanup(func() { wsCommandDeadline.Store(prev) })
}

// CommandDeadlineExemptTypesForTest returns the exempt set's message types.
func CommandDeadlineExemptTypesForTest() []string {
	out := make([]string, 0, len(commandDeadlineExempt))
	for typ := range commandDeadlineExempt {
		out = append(out, typ)
	}
	return out
}

// RegisteredTypesForTest returns every V2-registered message type.
func (h *Hub) RegisteredTypesForTest() []string {
	return h.registry.RegisteredV2Types()
}

// ReplaceHandlerForTest swaps typ's registered V2 handler for fn, keeping the
// deps. The type must already be registered.
func (h *Hub) ReplaceHandlerForTest(typ string, fn func(ctx context.Context) Result) {
	entry, ok := h.registry.handlersV2[typ]
	if !ok {
		panic("ReplaceHandlerForTest: type not registered: " + typ)
	}
	entry.handler = func(ctx context.Context, _ Command, _ ClientInfo, _ any) Result { return fn(ctx) }
	h.registry.handlersV2[typ] = entry
}

// handleVoiceJoin runs a voice join with ctx as both the frame and connection
// context.
func (h *Hub) handleVoiceJoin(ctx context.Context, c *Client, payload json.RawMessage, reqID string) {
	h.handleVoiceJoinFrame(ctx, ctx, c, payload, reqID)
}

// NewTestDMEvent builds the sequenced DM event the real handlers emit, for
// external tests that cannot implement the sealed Event interface themselves.
func NewTestDMEvent(evType string, channelID int64, participantIDs []int64, payload []byte) Event {
	return dmEvt{evType: evType, channelID: channelID, participantIDs: participantIDs, payload: payload}
}

// ClientForTest returns userID's newest live connection, or nil. Tests built
// around one connection per user use it where production code asks for
// clientsOf, isConnected or voiceClient.
func (h *Hub) ClientForTest(userID int64) *Client {
	conns := h.clientsOf(userID)
	if len(conns) == 0 {
		return nil
	}
	return conns[len(conns)-1]
}

// ClientsOfForTest exposes clientsOf.
func (h *Hub) ClientsOfForTest(userID int64) []*Client { return h.clientsOf(userID) }

// VoiceClientForTest exposes voiceClient.
func (h *Hub) VoiceClientForTest(userID int64) *Client { return h.voiceClient(userID) }

// subscriberForTest returns userID's subscribed connection on topic (the
// newest registered when there are several is not defined: tests that use it
// hold one connection per user), or nil.
func (ps *PubSub) subscriberForTest(topic Topic, userID int64) *Client {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	for c := range ps.topics[topic] {
		if c.userID == userID {
			return c
		}
	}
	return nil
}

// newestLocked returns userID's newest connection; the caller holds h.mu.
func (h *Hub) newestLocked(userID int64) *Client {
	conns := h.clients[userID]
	if len(conns) == 0 {
		return nil
	}
	return conns[len(conns)-1]
}

// MarkMobileForTest makes c a connection that declared the "mobile" client feature.
func MarkMobileForTest(c *Client) { c.features.mobile = true }
