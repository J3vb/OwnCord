package ws

import "testing"

// A network reconnect (lastSeq > 0) replaces the old connection with a client
// that newClient builds with channelID == 0, and the client never re-sends
// channel_focus after a resume (mountChannel early-returns on the same
// channel). If registerNow does not transfer the old connection's focused
// channel, its ChannelTopic re-subscribe is a no-op and the user silently
// stops receiving chat_message until they manually switch channels.
func TestRegisterNow_ResumeTransfersFocusedChannel(t *testing.T) {
	h := newEmitTestHub()

	old := NewTestClientWithChannel(h, 1, 7, make(chan []byte, 8))
	h.clients[1] = old
	h.pubsub.Subscribe(old, ChannelTopic(7)) // as the channel_focus applier does

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1 // network reconnect
	h.registerNow(replacement, map[int64]bool{7: true})

	if got := replacement.getChannelID(); got != 7 {
		t.Errorf("focused channel not transferred on resume: got %d, want 7", got)
	}
	h.pubsub.mu.RLock()
	sub := h.pubsub.topics[ChannelTopic(7)][1]
	h.pubsub.mu.RUnlock()
	if sub != replacement {
		t.Error("resumed connection is not subscribed to its focused channel's topic")
	}
}

// The transfer is READ-gated like every other ChannelTopic subscription: if
// READ_MESSAGES was revoked between the drop and the resume, the replacement
// must not inherit the focused channel (fail closed).
func TestRegisterNow_ResumeFocusedChannelStaysReadGated(t *testing.T) {
	h := newEmitTestHub()

	old := NewTestClientWithChannel(h, 1, 7, make(chan []byte, 8))
	h.clients[1] = old
	h.pubsub.Subscribe(old, ChannelTopic(7))

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1
	h.registerNow(replacement, nil) // no READ_MESSAGES anywhere

	if got := replacement.getChannelID(); got != 0 {
		t.Errorf("focused channel transferred without READ_MESSAGES: got %d, want 0", got)
	}
	h.pubsub.mu.RLock()
	sub := h.pubsub.topics[ChannelTopic(7)][1]
	h.pubsub.mu.RUnlock()
	if sub != nil {
		t.Error("channel topic subscription survived a resume without READ_MESSAGES")
	}
}

// A fresh connect (lastSeq == 0, e.g. F5) reloads the client app, which mounts
// its channel and sends channel_focus itself — the focused channel must not be
// inherited server-side, matching the voice-state semantics on this path.
func TestRegisterNow_FreshConnectDoesNotInheritFocusedChannel(t *testing.T) {
	h := newEmitTestHub()

	old := NewTestClientWithChannel(h, 1, 7, make(chan []byte, 8))
	h.clients[1] = old
	h.pubsub.Subscribe(old, ChannelTopic(7))

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	h.registerNow(replacement, map[int64]bool{7: true})

	if got := replacement.getChannelID(); got != 0 {
		t.Errorf("fresh connect inherited a focused channel: got %d, want 0", got)
	}
}
