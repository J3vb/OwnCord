package ws

import (
	"context"
	"testing"
	"time"
)

// drainChan reads all pending messages from a buffered chan []byte within a
// short timeout. Returns the collected messages.
func drainChan(ch chan []byte, timeout time.Duration) [][]byte {
	var msgs [][]byte
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case msg := <-ch:
			msgs = append(msgs, msg)
		case <-timer.C:
			return msgs
		}
	}
}

// newEmitTestHub creates a minimal Hub suitable for EmitEvents tests.
// No DB, no limiter, no registry — just the client map, broadcast channel,
// and the locks needed for delivery.
func newEmitTestHub() *Hub {
	return &Hub{
		clients:         make(map[int64]*Client),
		broadcast:       make(chan broadcastMsg, 64),
		clientEvents:    make(chan clientEvent, 32),
		stop:            make(chan struct{}),
		pubsub:          NewPubSub(),
		replayBuf:       NewEventRingBuffer(100),
		voiceKeyHolders: make(map[int64]int64),
		topicLimiter:    NewTopicRateLimiter(topicRateLimitPerSecond, time.Second),
	}
}

// registerEmitTestClient creates a test client, registers it directly in the
// hub's client map, and returns the send channel for assertions.
func registerEmitTestClient(h *Hub, userID, channelID int64) chan []byte {
	send := make(chan []byte, 192) // sized for all priority levels
	c := NewTestClientWithChannel(h, userID, channelID, send)
	// Wire high- and low-priority channels to the same observable channel so
	// drainChan captures messages regardless of which priority path delivers.
	c.sendHigh = send
	c.sendLow = send
	h.clients[userID] = c
	// Subscribe to pub/sub topics so deliverBroadcast can reach this client.
	h.pubsub.Subscribe(c, TopicGlobal)
	h.pubsub.Subscribe(c, UserTopic(userID))
	if channelID > 0 {
		h.pubsub.Subscribe(c, ChannelTopic(channelID))
	}
	return send
}

// registerEmitTestVoiceClient creates a test client in a voice channel.
func registerEmitTestVoiceClient(h *Hub, userID, channelID, voiceChID int64) chan []byte {
	send := make(chan []byte, 192)
	c := NewTestClientWithChannel(h, userID, channelID, send)
	c.sendHigh = send
	c.sendLow = send
	SetClientVoiceChID(c, voiceChID)
	h.clients[userID] = c
	// Subscribe to pub/sub topics so deliverBroadcast can reach this client.
	h.pubsub.Subscribe(c, TopicGlobal)
	h.pubsub.Subscribe(c, UserTopic(userID))
	if channelID > 0 {
		h.pubsub.Subscribe(c, ChannelTopic(channelID))
	}
	if voiceChID > 0 {
		h.pubsub.Subscribe(c, ChannelTopic(voiceChID))
	}
	return send
}

// ── stub events for testing ──────────────────────────────────────────────────

type stubChannelEvent struct {
	channelID int64
	payload   []byte
}

func (e stubChannelEvent) EventType() string { return "test_channel" }
func (e stubChannelEvent) ChannelID() int64  { return e.channelID }
func (e stubChannelEvent) Payload() []byte   { return e.payload }

type stubExcludeSenderEvent struct {
	channelID     int64
	excludeUserID int64
	payload       []byte
}

func (e stubExcludeSenderEvent) EventType() string    { return "test_exclude" }
func (e stubExcludeSenderEvent) ChannelID() int64     { return e.channelID }
func (e stubExcludeSenderEvent) ExcludeUserID() int64 { return e.excludeUserID }
func (e stubExcludeSenderEvent) Payload() []byte      { return e.payload }

type stubSequencedDMEvent struct {
	channelID      int64
	participantIDs []int64
	payload        []byte
}

func (e stubSequencedDMEvent) EventType() string       { return "test_dm" }
func (e stubSequencedDMEvent) ChannelID() int64        { return e.channelID }
func (e stubSequencedDMEvent) ParticipantIDs() []int64 { return e.participantIDs }
func (e stubSequencedDMEvent) Payload() []byte         { return e.payload }

type stubUserTargetedEvent struct {
	targetUserID int64
	payload      []byte
}

func (e stubUserTargetedEvent) EventType() string   { return "test_targeted" }
func (e stubUserTargetedEvent) TargetUserID() int64 { return e.targetUserID }
func (e stubUserTargetedEvent) Payload() []byte     { return e.payload }

type stubBroadcastAllEvent struct {
	payload []byte
}

func (e stubBroadcastAllEvent) EventType() string { return "test_broadcast_all" }
func (e stubBroadcastAllEvent) Payload() []byte   { return e.payload }

type stubVoiceChannelEvent struct {
	voiceChannelID int64
	excludeUserID  int64
	payload        []byte
}

func (e stubVoiceChannelEvent) EventType() string     { return "test_voice" }
func (e stubVoiceChannelEvent) VoiceChannelID() int64 { return e.voiceChannelID }
func (e stubVoiceChannelEvent) ExcludeUserID() int64  { return e.excludeUserID }
func (e stubVoiceChannelEvent) Payload() []byte       { return e.payload }

type stubVoiceChannelGuardedEvent struct {
	voiceChannelID int64
	targetUserID   int64
	payload        []byte
}

func (e stubVoiceChannelGuardedEvent) EventType() string     { return "test_voice_guarded" }
func (e stubVoiceChannelGuardedEvent) VoiceChannelID() int64 { return e.voiceChannelID }
func (e stubVoiceChannelGuardedEvent) TargetUserID() int64   { return e.targetUserID }
func (e stubVoiceChannelGuardedEvent) Payload() []byte       { return e.payload }

type stubUnknownEvent struct{}

func (e stubUnknownEvent) EventType() string { return "test_unknown" }

// ── tests ────────────────────────────────────────────────────────────────────

func TestEmitEvents_ChannelEvent_CallsBroadcastToChannel(t *testing.T) {
	h := newEmitTestHub()
	send1 := registerEmitTestClient(h, 1, 42)
	_ = registerEmitTestClient(h, 2, 99) // different channel

	payload := []byte(`{"type":"test"}`)
	events := []Event{stubChannelEvent{channelID: 42, payload: payload}}

	// BroadcastToChannel is async (via broadcast chan), so we run the
	// hub loop briefly to deliver.
	go h.Run()
	defer h.Stop()

	h.EmitEvents(context.Background(), events)

	// Give the hub loop time to deliver.
	msgs := drainChan(send1, 100*time.Millisecond)
	if len(msgs) == 0 {
		t.Fatal("expected client 1 (channel 42) to receive the channel event")
	}
}

func TestEmitEvents_ExcludeSenderEvent(t *testing.T) {
	h := newEmitTestHub()
	sendSender := registerEmitTestClient(h, 1, 42)
	sendOther := registerEmitTestClient(h, 2, 42)

	payload := []byte(`{"type":"typing"}`)
	events := []Event{stubExcludeSenderEvent{channelID: 42, excludeUserID: 1, payload: payload}}

	h.EmitEvents(context.Background(), events)

	// broadcastExcludeLow is synchronous — check immediately.
	senderMsgs := drainChan(sendSender, 50*time.Millisecond)
	otherMsgs := drainChan(sendOther, 50*time.Millisecond)

	if len(senderMsgs) != 0 {
		t.Errorf("sender should be excluded, got %d messages", len(senderMsgs))
	}
	if len(otherMsgs) != 1 {
		t.Errorf("other client should receive 1 message, got %d", len(otherMsgs))
	}
}

func TestEmitEvents_SequencedDMEvent(t *testing.T) {
	h := newEmitTestHub()
	send1 := registerEmitTestClient(h, 1, 0)
	send2 := registerEmitTestClient(h, 2, 0)
	send3 := registerEmitTestClient(h, 3, 0) // not a participant

	payload := []byte(`{"type":"dm_msg"}`)
	events := []Event{stubSequencedDMEvent{
		channelID:      100,
		participantIDs: []int64{1, 2},
		payload:        payload,
	}}

	h.EmitEvents(context.Background(), events)

	msgs1 := drainChan(send1, 50*time.Millisecond)
	msgs2 := drainChan(send2, 50*time.Millisecond)
	msgs3 := drainChan(send3, 50*time.Millisecond)

	if len(msgs1) != 1 {
		t.Errorf("participant 1 should receive 1 message, got %d", len(msgs1))
	}
	if len(msgs2) != 1 {
		t.Errorf("participant 2 should receive 1 message, got %d", len(msgs2))
	}
	if len(msgs3) != 0 {
		t.Errorf("non-participant (client 3) should receive 0 messages, got %d", len(msgs3))
	}
}

func TestEmitEvents_UserTargetedEvent(t *testing.T) {
	h := newEmitTestHub()
	send1 := registerEmitTestClient(h, 1, 0)
	send2 := registerEmitTestClient(h, 2, 0)

	payload := []byte(`{"type":"targeted"}`)
	events := []Event{stubUserTargetedEvent{targetUserID: 2, payload: payload}}

	h.EmitEvents(context.Background(), events)

	msgs1 := drainChan(send1, 50*time.Millisecond)
	msgs2 := drainChan(send2, 50*time.Millisecond)

	if len(msgs1) != 0 {
		t.Errorf("user 1 should not receive targeted event, got %d", len(msgs1))
	}
	if len(msgs2) != 1 {
		t.Errorf("user 2 should receive 1 targeted message, got %d", len(msgs2))
	}
}

func TestEmitEvents_BroadcastAllEvent(t *testing.T) {
	h := newEmitTestHub()
	send1 := registerEmitTestClient(h, 1, 42)
	send2 := registerEmitTestClient(h, 2, 99)

	payload := []byte(`{"type":"global"}`)
	events := []Event{stubBroadcastAllEvent{payload: payload}}

	// BroadcastToAll goes through the broadcast channel, need hub loop.
	go h.Run()
	defer h.Stop()

	h.EmitEvents(context.Background(), events)

	msgs1 := drainChan(send1, 100*time.Millisecond)
	msgs2 := drainChan(send2, 100*time.Millisecond)

	if len(msgs1) == 0 {
		t.Error("user 1 should receive broadcast_all event")
	}
	if len(msgs2) == 0 {
		t.Error("user 2 should receive broadcast_all event")
	}
}

func TestEmitEvents_VoiceChannelEvent(t *testing.T) {
	h := newEmitTestHub()
	sendSender := registerEmitTestVoiceClient(h, 1, 0, 50)
	sendOther := registerEmitTestVoiceClient(h, 2, 0, 50)
	sendOutside := registerEmitTestVoiceClient(h, 3, 0, 99) // different voice channel

	payload := []byte(`{"type":"voice_e2ee"}`)
	events := []Event{stubVoiceChannelEvent{
		voiceChannelID: 50,
		excludeUserID:  1,
		payload:        payload,
	}}

	h.EmitEvents(context.Background(), events)

	senderMsgs := drainChan(sendSender, 50*time.Millisecond)
	otherMsgs := drainChan(sendOther, 50*time.Millisecond)
	outsideMsgs := drainChan(sendOutside, 50*time.Millisecond)

	if len(senderMsgs) != 0 {
		t.Errorf("sender should be excluded from voice event, got %d", len(senderMsgs))
	}
	if len(otherMsgs) != 1 {
		t.Errorf("voice participant should receive 1 message, got %d", len(otherMsgs))
	}
	if len(outsideMsgs) != 0 {
		t.Errorf("client in different voice channel should not receive, got %d", len(outsideMsgs))
	}
}

func TestEmitEvents_VoiceChannelGuardedEvent(t *testing.T) {
	h := newEmitTestHub()
	// Target is in voice channel 50.
	sendTarget := registerEmitTestVoiceClient(h, 2, 0, 50)
	// User 3 is in the same voice channel but is not the target.
	sendOther := registerEmitTestVoiceClient(h, 3, 0, 50)
	// User 4 is in a different voice channel.
	sendOutside := registerEmitTestVoiceClient(h, 4, 0, 99)

	payload := []byte(`{"type":"voice_e2ee_offer"}`)
	events := []Event{stubVoiceChannelGuardedEvent{
		voiceChannelID: 50,
		targetUserID:   2,
		payload:        payload,
	}}

	h.EmitEvents(context.Background(), events)

	targetMsgs := drainChan(sendTarget, 50*time.Millisecond)
	otherMsgs := drainChan(sendOther, 50*time.Millisecond)
	outsideMsgs := drainChan(sendOutside, 50*time.Millisecond)

	if len(targetMsgs) != 1 {
		t.Errorf("target in voice channel should receive 1 message, got %d", len(targetMsgs))
	}
	if len(otherMsgs) != 0 {
		t.Errorf("non-target in same voice channel should not receive, got %d", len(otherMsgs))
	}
	if len(outsideMsgs) != 0 {
		t.Errorf("client in different voice channel should not receive, got %d", len(outsideMsgs))
	}
}

func TestEmitEvents_VoiceChannelGuardedEvent_TargetNotInChannel(t *testing.T) {
	h := newEmitTestHub()
	// Target is in voice channel 99, but event targets voice channel 50.
	sendTarget := registerEmitTestVoiceClient(h, 2, 0, 99)

	payload := []byte(`{"type":"voice_e2ee_offer"}`)
	events := []Event{stubVoiceChannelGuardedEvent{
		voiceChannelID: 50,
		targetUserID:   2,
		payload:        payload,
	}}

	h.EmitEvents(context.Background(), events)

	targetMsgs := drainChan(sendTarget, 50*time.Millisecond)
	if len(targetMsgs) != 0 {
		t.Errorf("target in wrong voice channel should not receive, got %d", len(targetMsgs))
	}
}

func TestEmitEvents_EmptyEvents_NoOp(t *testing.T) {
	h := newEmitTestHub()
	_ = registerEmitTestClient(h, 1, 42)

	// Should not panic or block.
	h.EmitEvents(context.Background(), nil)
	h.EmitEvents(context.Background(), []Event{})
}

func TestEmitEvents_MixedEventTypes_AllRouted(t *testing.T) {
	h := newEmitTestHub()
	sendCh := registerEmitTestClient(h, 1, 42)
	sendTarget := registerEmitTestClient(h, 2, 0)

	// BroadcastToChannel is async, need hub loop for channel events.
	go h.Run()
	defer h.Stop()

	events := []Event{
		stubExcludeSenderEvent{channelID: 42, excludeUserID: 99, payload: []byte(`{"e":1}`)},
		stubUserTargetedEvent{targetUserID: 2, payload: []byte(`{"e":2}`)},
	}

	h.EmitEvents(context.Background(), events)

	chMsgs := drainChan(sendCh, 100*time.Millisecond)
	targetMsgs := drainChan(sendTarget, 100*time.Millisecond)

	if len(chMsgs) != 1 {
		t.Errorf("channel client should receive exclude event, got %d", len(chMsgs))
	}
	if len(targetMsgs) != 1 {
		t.Errorf("targeted client should receive 1 message, got %d", len(targetMsgs))
	}
}

func TestEmitEvents_UnknownType_LogsWarning(t *testing.T) {
	h := newEmitTestHub()
	_ = registerEmitTestClient(h, 1, 42)

	// Should not panic; logs a warning (we verify no crash, not log content).
	h.EmitEvents(context.Background(), []Event{stubUnknownEvent{}})
}
