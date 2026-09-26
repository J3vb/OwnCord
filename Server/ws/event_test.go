package ws

import (
	"bytes"
	"errors"
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
	var ce ClientError
	ok := errors.As(r.Error, &ce)
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
	if !bytes.Equal(r.Reply, reply) {
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
		{"TypingChannelEvent", TypingChannelEvent{}, MsgTypeTyping},
		{"TypingDMEvent", TypingDMEvent{}, MsgTypeTyping},
		{"PresenceEvent", PresenceEvent{}, MsgTypePresence},
		{"VoiceStateEvent", VoiceStateEvent{}, MsgTypeVoiceState},
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
	evt := channelEvt{evType: MsgTypeChatMessage, channelID: 10, payload: []byte("p")}
	var iface ChannelEvent = evt
	if iface.ChannelID() != 10 {
		t.Errorf("ChannelID() = %d, want 10", iface.ChannelID())
	}
	if iface.Payload() == nil {
		t.Error("Payload() should not be nil")
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
	evt := dmEvt{evType: MsgTypeChatMessage, channelID: 100, participantIDs: []int64{1, 2}, payload: []byte("m")}
	var iface SequencedDMEvent = evt
	if iface.ChannelID() != 100 {
		t.Errorf("ChannelID() = %d, want 100", iface.ChannelID())
	}
	got := iface.ParticipantIDs()
	if len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Errorf("ParticipantIDs() = %v, want [1 2]", got)
	}
	if iface.Payload() == nil {
		t.Error("Payload() should not be nil")
	}
}

func TestSequencedDMEventDefensiveCopy(t *testing.T) {
	orig := []int64{1, 2, 3}
	evt := dmEvt{participantIDs: orig}
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
	// dmEvt satisfies SequencedDMEvent AND ChannelEvent (it has ChannelID +
	// Payload). This test documents that EmitEvents must check SequencedDMEvent
	// first.
	evt := Event(dmEvt{evType: MsgTypeChatMessage, channelID: 1, participantIDs: []int64{1, 2}, payload: []byte("x")})
	// Must satisfy SequencedDMEvent.
	if _, ok := evt.(SequencedDMEvent); !ok {
		t.Errorf("%T does not implement SequencedDMEvent", evt)
	}
	// Must also satisfy ChannelEvent (since it has ChannelID + Payload).
	if _, ok := evt.(ChannelEvent); !ok {
		t.Errorf("%T does not implement ChannelEvent", evt)
	}
}
