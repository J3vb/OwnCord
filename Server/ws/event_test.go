package ws

import (
	"testing"
)

func TestClientErrorFormat(t *testing.T) {
	err := ClientError{Code: "BAD_REQUEST", Message: "field missing"}
	want := "BAD_REQUEST: field missing"
	if got := err.Error(); got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestClientErrorImplementsError(t *testing.T) {
	var _ error = ClientError{}
}

func TestResultEmpty(t *testing.T) {
	r := Result{}
	if r.Events != nil {
		t.Error("expected nil Events")
	}
	if r.Error != nil {
		t.Error("expected nil Error")
	}
	if r.Reply != nil {
		t.Error("expected nil Reply")
	}
}

func TestResultWithError(t *testing.T) {
	r := Result{Error: ClientError{Code: "RATE_LIMITED", Message: "slow down"}}
	if r.Error == nil {
		t.Fatal("expected non-nil Error")
	}
	ce, ok := r.Error.(ClientError)
	if !ok {
		t.Fatal("expected ClientError type")
	}
	if ce.Code != "RATE_LIMITED" {
		t.Errorf("Code = %q, want %q", ce.Code, "RATE_LIMITED")
	}
}

func TestResultWithReply(t *testing.T) {
	reply := []byte(`{"type":"chat_send_ok","id":"req-1"}`)
	r := Result{Reply: reply}
	if string(r.Reply) != string(reply) {
		t.Errorf("Reply = %q, want %q", r.Reply, reply)
	}
}

func TestResultWithEvents(t *testing.T) {
	evt := PresenceEvent{payload: []byte(`{"type":"presence"}`)}
	r := Result{Events: []Event{evt}}
	if len(r.Events) != 1 {
		t.Fatalf("len(Events) = %d, want 1", len(r.Events))
	}
	if r.Events[0].EventType() != MsgTypePresence {
		t.Errorf("EventType() = %q, want %q", r.Events[0].EventType(), MsgTypePresence)
	}
}

// ── EventType tests ─────────────────────────────────────────────────────────

func TestEventTypes(t *testing.T) {
	tests := []struct {
		name     string
		event    Event
		wantType string
	}{
		{"MessageSentChannelEvent", MessageSentChannelEvent{}, MsgTypeChatMessage},
		{"MessageSentDMEvent", MessageSentDMEvent{}, MsgTypeChatMessage},
		{"MessageEditedChannelEvent", MessageEditedChannelEvent{}, MsgTypeChatEdited},
		{"MessageEditedDMEvent", MessageEditedDMEvent{}, MsgTypeChatEdited},
		{"MessageDeletedChannelEvent", MessageDeletedChannelEvent{}, MsgTypeChatDeleted},
		{"MessageDeletedDMEvent", MessageDeletedDMEvent{}, MsgTypeChatDeleted},
		{"TypingChannelEvent", TypingChannelEvent{}, MsgTypeTyping},
		{"TypingDMEvent", TypingDMEvent{}, MsgTypeTyping},
		{"PresenceEvent", PresenceEvent{}, MsgTypePresence},
		{"ReactionChannelEvent", ReactionChannelEvent{}, MsgTypeReactionUpdate},
		{"ReactionDMEvent", ReactionDMEvent{}, MsgTypeReactionUpdate},
		{"VoiceStateEvent", VoiceStateEvent{}, MsgTypeVoiceState},
		{"VoiceLeaveEvent", VoiceLeaveEvent{}, MsgTypeVoiceLeaveBC},
		{"VoiceE2EEAnnounceEvent", VoiceE2EEAnnounceEvent{}, MsgTypeVoiceE2EEAnnounceBC},
		{"VoiceE2EEOfferGuardedEvent", VoiceE2EEOfferGuardedEvent{}, MsgTypeVoiceE2EEOfferRelay},
		{"DMChannelOpenEvent", DMChannelOpenEvent{}, MsgTypeDMChannelOpen},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.event.EventType(); got != tt.wantType {
				t.Errorf("EventType() = %q, want %q", got, tt.wantType)
			}
		})
	}
}

// ── Routing interface tests ─────────────────────────────────────────────────

func TestChannelEventInterface(t *testing.T) {
	events := []struct {
		name  string
		event ChannelEvent
		chID  int64
	}{
		{"MessageSentChannelEvent", MessageSentChannelEvent{channelID: 10, payload: []byte("p")}, 10},
		{"MessageEditedChannelEvent", MessageEditedChannelEvent{channelID: 20, payload: []byte("q")}, 20},
		{"MessageDeletedChannelEvent", MessageDeletedChannelEvent{channelID: 30, payload: []byte("r")}, 30},
		{"ReactionChannelEvent", ReactionChannelEvent{channelID: 40, payload: []byte("s")}, 40},
	}
	for _, tt := range events {
		t.Run(tt.name, func(t *testing.T) {
			if tt.event.ChannelID() != tt.chID {
				t.Errorf("ChannelID() = %d, want %d", tt.event.ChannelID(), tt.chID)
			}
			if tt.event.Payload() == nil {
				t.Error("Payload() should not be nil")
			}
		})
	}
}

func TestExcludeSenderEventInterface(t *testing.T) {
	evt := TypingChannelEvent{channelID: 5, excludeUserID: 42, payload: []byte("typing")}
	var iface ExcludeSenderEvent = evt
	if iface.ChannelID() != 5 {
		t.Errorf("ChannelID() = %d, want 5", iface.ChannelID())
	}
	if iface.ExcludeUserID() != 42 {
		t.Errorf("ExcludeUserID() = %d, want 42", iface.ExcludeUserID())
	}
	if string(iface.Payload()) != "typing" {
		t.Errorf("Payload() = %q, want %q", iface.Payload(), "typing")
	}
}

func TestSequencedDMEventInterface(t *testing.T) {
	events := []struct {
		name  string
		event SequencedDMEvent
		chID  int64
		pIDs  []int64
	}{
		{"MessageSentDMEvent", MessageSentDMEvent{channelID: 100, participantIDs: []int64{1, 2}, payload: []byte("m")}, 100, []int64{1, 2}},
		{"MessageEditedDMEvent", MessageEditedDMEvent{channelID: 101, participantIDs: []int64{3, 4}, payload: []byte("e")}, 101, []int64{3, 4}},
		{"MessageDeletedDMEvent", MessageDeletedDMEvent{channelID: 102, participantIDs: []int64{5, 6}, payload: []byte("d")}, 102, []int64{5, 6}},
		{"ReactionDMEvent", ReactionDMEvent{channelID: 103, participantIDs: []int64{7, 8}, payload: []byte("r")}, 103, []int64{7, 8}},
	}
	for _, tt := range events {
		t.Run(tt.name, func(t *testing.T) {
			if tt.event.ChannelID() != tt.chID {
				t.Errorf("ChannelID() = %d, want %d", tt.event.ChannelID(), tt.chID)
			}
			got := tt.event.ParticipantIDs()
			if len(got) != len(tt.pIDs) {
				t.Fatalf("ParticipantIDs() len = %d, want %d", len(got), len(tt.pIDs))
			}
			for i, id := range tt.pIDs {
				if got[i] != id {
					t.Errorf("ParticipantIDs()[%d] = %d, want %d", i, got[i], id)
				}
			}
			if tt.event.Payload() == nil {
				t.Error("Payload() should not be nil")
			}
		})
	}
}

func TestSequencedDMEventDefensiveCopy(t *testing.T) {
	orig := []int64{1, 2, 3}
	evt := MessageSentDMEvent{participantIDs: orig}
	got := evt.ParticipantIDs()
	got[0] = 999
	if evt.participantIDs[0] == 999 {
		t.Error("ParticipantIDs() did not return a defensive copy")
	}
}

func TestUserTargetedEventInterface(t *testing.T) {
	events := []struct {
		name   string
		event  UserTargetedEvent
		target int64
	}{
		{"TypingDMEvent", TypingDMEvent{targetUserID: 50, payload: []byte("t")}, 50},
		{"DMChannelOpenEvent", DMChannelOpenEvent{targetUserID: 70, payload: []byte("d")}, 70},
	}
	for _, tt := range events {
		t.Run(tt.name, func(t *testing.T) {
			if tt.event.TargetUserID() != tt.target {
				t.Errorf("TargetUserID() = %d, want %d", tt.event.TargetUserID(), tt.target)
			}
			if tt.event.Payload() == nil {
				t.Error("Payload() should not be nil")
			}
		})
	}
}

func TestBroadcastAllEventInterface(t *testing.T) {
	events := []struct {
		name  string
		event BroadcastAllEvent
	}{
		{"PresenceEvent", PresenceEvent{payload: []byte("p")}},
		{"VoiceStateEvent", VoiceStateEvent{payload: []byte("vs")}},
		{"VoiceLeaveEvent", VoiceLeaveEvent{payload: []byte("vl")}},
	}
	for _, tt := range events {
		t.Run(tt.name, func(t *testing.T) {
			if tt.event.Payload() == nil {
				t.Error("Payload() should not be nil")
			}
		})
	}
}

func TestVoiceChannelEventInterface(t *testing.T) {
	evt := VoiceE2EEAnnounceEvent{voiceChannelID: 15, excludeUserID: 7, payload: []byte("ann")}
	var iface VoiceChannelEvent = evt
	if iface.VoiceChannelID() != 15 {
		t.Errorf("VoiceChannelID() = %d, want 15", iface.VoiceChannelID())
	}
	if iface.ExcludeUserID() != 7 {
		t.Errorf("ExcludeUserID() = %d, want 7", iface.ExcludeUserID())
	}
	if string(iface.Payload()) != "ann" {
		t.Errorf("Payload() = %q, want %q", iface.Payload(), "ann")
	}
}

func TestVoiceChannelGuardedEventInterface(t *testing.T) {
	evt := VoiceE2EEOfferGuardedEvent{voiceChannelID: 20, targetUserID: 5, payload: []byte("offer")}
	var iface VoiceChannelGuardedEvent = evt
	if iface.VoiceChannelID() != 20 {
		t.Errorf("VoiceChannelID() = %d, want 20", iface.VoiceChannelID())
	}
	if iface.TargetUserID() != 5 {
		t.Errorf("TargetUserID() = %d, want 5", iface.TargetUserID())
	}
	if string(iface.Payload()) != "offer" {
		t.Errorf("Payload() = %q, want %q", iface.Payload(), "offer")
	}
}

// ── SequencedDMEvent checked before ChannelEvent ────────────────────────────

func TestDMEventsImplementBothInterfaces(t *testing.T) {
	// SequencedDMEvent types also satisfy ChannelEvent (they have ChannelID + Payload).
	// This test documents that EmitEvents must check SequencedDMEvent first.
	dmEvents := []Event{
		MessageSentDMEvent{channelID: 1, participantIDs: []int64{1, 2}, payload: []byte("x")},
		MessageEditedDMEvent{channelID: 2, participantIDs: []int64{3, 4}, payload: []byte("y")},
		MessageDeletedDMEvent{channelID: 3, participantIDs: []int64{5, 6}, payload: []byte("z")},
		ReactionDMEvent{channelID: 4, participantIDs: []int64{7, 8}, payload: []byte("w")},
	}
	for _, evt := range dmEvents {
		// Must satisfy SequencedDMEvent.
		if _, ok := evt.(SequencedDMEvent); !ok {
			t.Errorf("%T does not implement SequencedDMEvent", evt)
		}
		// Must also satisfy ChannelEvent (since they have ChannelID + Payload).
		if _, ok := evt.(ChannelEvent); !ok {
			t.Errorf("%T does not implement ChannelEvent", evt)
		}
	}
}
