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
	h.clients[1] = []*Client{old}
	h.pubsub.Subscribe(old, ChannelTopic(7)) // as the channel_focus applier does

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1 // network reconnect
	h.registerNowTest(replacement, map[int64]bool{7: true})

	if got := replacement.getChannelID(); got != 7 {
		t.Errorf("focused channel not transferred on resume: got %d, want 7", got)
	}
	sub := h.pubsub.subscriberForTest(ChannelTopic(7), 1)
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
	h.clients[1] = []*Client{old}
	h.pubsub.Subscribe(old, ChannelTopic(7))

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1
	h.registerNowTest(replacement, nil) // no READ_MESSAGES anywhere

	if got := replacement.getChannelID(); got != 0 {
		t.Errorf("focused channel transferred without READ_MESSAGES: got %d, want 0", got)
	}
	sub := h.pubsub.subscriberForTest(ChannelTopic(7), 1)
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
	h.clients[1] = []*Client{old}

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1
	h.registerNowTest(replacement, nil) // closes old's send channels

	// The old connection's handler completes its Subscribe late.
	h.pubsub.Subscribe(old, ChannelTopic(7))

	sub := h.pubsub.subscriberForTest(ChannelTopic(7), 1)
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
	h.clients[1] = []*Client{old}
	h.pubsub.Subscribe(old, ChannelTopic(7))

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	h.registerNowTest(replacement, map[int64]bool{7: true})

	if got := replacement.getChannelID(); got != 0 {
		t.Errorf("fresh connect inherited a focused channel: got %d, want 0", got)
	}
}

// Several devices stay signed in at once: a connection of another SESSION is
// added beside the live one, whatever the wake flag the client sent (the auth
// frame's `wake` is accepted and ignored). The live connection is untouched.
func TestRegisterNow_AnotherSession_CoexistsAndKeepsLive(t *testing.T) {
	h := newEmitTestHub()

	live := NewTestClient(h, 1, make(chan []byte, 8))
	live.tokenHash = "session-a"
	h.clients[1] = []*Client{live}

	other := NewTestClient(h, 1, make(chan []byte, 8))
	other.tokenHash = "session-b"

	h.registerNowTest(other, nil)
	if got := h.clientsOf(1); len(got) != 2 || got[0] != live || got[1] != other {
		t.Fatalf("connections = %v, want [live other]", got)
	}
	if live.isSendClosed() {
		t.Fatal("another device's connect closed the live session's send channel")
	}
}

// A reconnect of the SAME session (this device's own stale socket) replaces the
// dead connection, and only that one.
func TestRegisterNow_SameSession_ReplacesOnlyItself(t *testing.T) {
	h := newEmitTestHub()

	a := NewTestClient(h, 1, make(chan []byte, 8))
	a.tokenHash = "session-a"
	b := NewTestClient(h, 1, make(chan []byte, 8))
	b.tokenHash = "session-b"
	h.clients[1] = []*Client{a, b}

	again := NewTestClient(h, 1, make(chan []byte, 8))
	again.tokenHash = "session-a"
	h.registerNowTest(again, nil)

	got := h.clientsOf(1)
	if len(got) != 2 || got[0] != b || got[1] != again {
		t.Fatalf("connections = %v, want [b again]", got)
	}
	if !a.isSendClosed() {
		t.Fatal("the replaced same-session connection was not closed")
	}
	if b.isSendClosed() {
		t.Fatal("a same-session replacement closed the other device")
	}
}

// Another session's call parked in the RT-8 grace window does not block a
// connect: the new device registers and the parked call stays parked for its
// own device. A resume cannot inherit it.
func TestRegisterNow_AnotherSessionGraced_StaysParked(t *testing.T) {
	h := newEmitTestHub()

	parked := NewTestClient(h, 1, make(chan []byte, 8))
	parked.tokenHash = "session-a"
	entry := &voiceGraceEntry{client: parked, snap: slotSnap{chID: 7, joinToken: "jt", completed: true}}
	h.voiceReg.voiceGrace.put(1, entry, func() {})
	t.Cleanup(func() { h.voiceReg.voiceGrace.take(1) })

	other := NewTestClient(h, 1, make(chan []byte, 8))
	other.tokenHash = "session-b"
	other.lastSeq = 5

	h.registerNowTest(other, nil)
	if !h.isRegistered(other) {
		t.Fatal("the new device was not registered")
	}
	if h.voiceReg.voiceGrace.get(1) != entry {
		t.Fatal("the new device took the other session's parked call")
	}
	if got := other.voice.channel(); got != 0 {
		t.Fatalf("another session's resume inherited the parked call: voice channel %d", got)
	}
}

// A fresh connect of another session leaves the parked call parked too
// (voiceTxn.inherit's discard is the same session's only).
func TestRegisterNow_FreshConnectAnotherSession_KeepsParkedEntry(t *testing.T) {
	h := newEmitTestHub()

	parked := NewTestClient(h, 1, make(chan []byte, 8))
	parked.tokenHash = "session-a"
	entry := &voiceGraceEntry{client: parked, snap: slotSnap{chID: 7, joinToken: "jt", completed: true}}
	h.voiceReg.voiceGrace.put(1, entry, func() {})
	t.Cleanup(func() { h.voiceReg.voiceGrace.take(1) })

	other := NewTestClient(h, 1, make(chan []byte, 8))
	other.tokenHash = "session-b"
	h.registerNowTest(other, nil)
	if h.voiceReg.voiceGrace.get(1) != entry {
		t.Fatal("a fresh connect on another device discarded the parked call")
	}
}

// The same session's own parked call is inherited by its resume, as ever.
func TestRegisterNow_SameSessionGraced_Inherits(t *testing.T) {
	h := newEmitTestHub()

	parked := NewTestClient(h, 1, make(chan []byte, 8))
	parked.tokenHash = "session-a"
	h.voiceReg.voiceGrace.put(1, &voiceGraceEntry{client: parked, snap: slotSnap{chID: 7, joinToken: "jt", completed: true}}, func() {})

	resume := NewTestClient(h, 1, make(chan []byte, 8))
	resume.tokenHash = "session-a"
	resume.lastSeq = 5

	h.registerNowTest(resume, nil)
	if got := resume.voice.channel(); got != 7 {
		t.Fatalf("same-session resume did not inherit its parked call: voice channel %d", got)
	}
}
