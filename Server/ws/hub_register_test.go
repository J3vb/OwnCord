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

// A dying connection's in-flight handler (e.g. a channel_focus mid DB
// round-trip in its readPump) can call Subscribe after registerNow stripped
// the old client via UnsubscribeAll — stealing the topic from the
// replacement: the replacement's own unsubscribes then skip the entry
// (unsubscribeLocked's identity guard) while publishes go to the closed
// connection. Subscribe must refuse a client whose send is already closed.
func TestSubscribe_RefusesReplacedClientWithClosedSend(t *testing.T) {
	h := newEmitTestHub()

	old := NewTestClient(h, 1, make(chan []byte, 8))
	h.clients[1] = old

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1
	h.registerNow(replacement, nil) // closes old's send channels

	// The old connection's handler completes its Subscribe late.
	h.pubsub.Subscribe(old, ChannelTopic(7))

	h.pubsub.mu.RLock()
	sub := h.pubsub.topics[ChannelTopic(7)][1]
	h.pubsub.mu.RUnlock()
	if sub == old {
		t.Error("closed connection stole the topic subscription from its replacement")
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

// U4: registerNow is the atomic authority for the wake refusal. A wake
// reconnect (wakeReconnect) whose token hash differs from the live client's is
// another SESSION — another device — and must be refused without touching the
// live connection. Verified under h.mu, which is where the race with a
// concurrent connect is closed.
func TestRegisterNow_WakeReconnectAnotherSession_RefusedNotRegistered(t *testing.T) {
	h := newEmitTestHub()

	live := NewTestClient(h, 1, make(chan []byte, 8))
	live.tokenHash = "session-a"
	h.clients[1] = live

	wake := NewTestClient(h, 1, make(chan []byte, 8))
	wake.tokenHash = "session-b"
	wake.wakeReconnect = true

	if refused := h.registerNow(wake, nil); !refused {
		t.Fatal("wake reconnect from another session was not refused")
	}
	if h.clients[1] != live {
		t.Fatal("wake refusal displaced the live session")
	}
	if live.isSendClosed() {
		t.Fatal("wake refusal closed the live session's send channel")
	}
}

// U4: a wake reconnect for the SAME session (this device's own stale socket)
// is not another device — it must replace the dead connection normally.
func TestRegisterNow_WakeReconnectSameSession_Replaces(t *testing.T) {
	h := newEmitTestHub()

	live := NewTestClient(h, 1, make(chan []byte, 8))
	live.tokenHash = "session-a"
	h.clients[1] = live

	wake := NewTestClient(h, 1, make(chan []byte, 8))
	wake.tokenHash = "session-a"
	wake.wakeReconnect = true

	if refused := h.registerNow(wake, nil); refused {
		t.Fatal("wake reconnect for the same session was refused")
	}
	if h.clients[1] != wake {
		t.Fatal("same-session wake reconnect did not take the connection")
	}
}

// U4: a DIFFERENT session's call parked in the RT-8 grace window is held by
// another device too. A wake reconnect must not inherit (resume) or discard
// (fresh connect) it — registerNow refuses and leaves the parked entry alone.
func TestRegisterNow_WakeReconnectAnotherSessionGraced_Refused(t *testing.T) {
	h := newEmitTestHub()

	parked := NewTestClient(h, 1, make(chan []byte, 8))
	parked.tokenHash = "session-a"
	entry := &voiceGraceEntry{client: parked, channelID: 7, joinToken: "jt"}
	h.voiceGrace.put(1, entry, func() {})
	t.Cleanup(func() { h.voiceGrace.take(1) })

	wake := NewTestClient(h, 1, make(chan []byte, 8))
	wake.tokenHash = "session-b"
	wake.wakeReconnect = true
	wake.lastSeq = 5

	if refused := h.registerNow(wake, nil); !refused {
		t.Fatal("wake reconnect was not refused while another session's call was parked")
	}
	if _, ok := h.clients[1]; ok {
		t.Fatal("refused wake was registered")
	}
	if h.voiceGrace.get(1) != entry {
		t.Fatal("refused wake took the other session's parked call")
	}
}

// U4: the same session's own parked call is not another device — a wake
// resume inherits it as an ordinary RT-8 resume does.
func TestRegisterNow_WakeReconnectSameSessionGraced_Inherits(t *testing.T) {
	h := newEmitTestHub()

	parked := NewTestClient(h, 1, make(chan []byte, 8))
	parked.tokenHash = "session-a"
	h.voiceGrace.put(1, &voiceGraceEntry{client: parked, channelID: 7, joinToken: "jt"}, func() {})

	wake := NewTestClient(h, 1, make(chan []byte, 8))
	wake.tokenHash = "session-a"
	wake.wakeReconnect = true
	wake.lastSeq = 5

	if refused := h.registerNow(wake, nil); refused {
		t.Fatal("same-session wake with its own parked call was refused")
	}
	if got := wake.getVoiceChID(); got != 7 {
		t.Fatalf("same-session wake did not inherit its parked call: voice channel %d", got)
	}
}
