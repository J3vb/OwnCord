package ws

import (
	"encoding/json"
	"testing"
)

// allClientToServerTypes returns every client-to-server message type constant
// that should have a CommandConstructor entry (excludes "auth" which is handled
// separately by the auth flow).
func allClientToServerTypes() []string {
	return []string{
		MsgTypePing,
		MsgTypeChatSend,
		MsgTypeChatEdit,
		MsgTypeChatDelete,
		MsgTypeTypingStart,
		MsgTypePresenceUpdate,
		MsgTypeChannelFocus,
		MsgTypeMarkRead,
		MsgTypeReactionAdd,
		MsgTypeReactionRemove,
		MsgTypeVoiceJoin,
		MsgTypeVoiceLeave,
		MsgTypeVoiceTokenRefresh,
		MsgTypeVoiceMute,
		MsgTypeVoiceDeafen,
		MsgTypeVoiceCamera,
		MsgTypeVoiceScreenshare,
		MsgTypeVoiceE2EEAnnounce,
		MsgTypeVoiceE2EEOffer,
	}
}

func TestCommandConstructorsCoverage(t *testing.T) {
	for _, msgType := range allClientToServerTypes() {
		if _, ok := commandConstructors[msgType]; !ok {
			t.Errorf("commandConstructors missing entry for %q", msgType)
		}
	}
}

func TestCommandTypeAndUserID(t *testing.T) {
	tests := []struct {
		name     string
		cmd      Command
		wantType string
		wantUID  int64
	}{
		{"PingCmd", PingCmd{userID: 1}, MsgTypePing, 1},
		{"ChatSendCmd", ChatSendCmd{userID: 2, channelID: 10}, MsgTypeChatSend, 2},
		{"ChatEditCmd", ChatEditCmd{userID: 3, messageID: 20}, MsgTypeChatEdit, 3},
		{"ChatDeleteCmd", ChatDeleteCmd{userID: 4, messageID: 30}, MsgTypeChatDelete, 4},
		{"TypingStartCmd", TypingStartCmd{userID: 5, channelID: 11}, MsgTypeTypingStart, 5},
		{"PresenceUpdateCmd", PresenceUpdateCmd{userID: 6, status: "online"}, MsgTypePresenceUpdate, 6},
		{"ChannelFocusCmd", ChannelFocusCmd{userID: 7, channelID: 12}, MsgTypeChannelFocus, 7},
		{"MarkReadCmd", MarkReadCmd{userID: 7, channelID: 12}, MsgTypeMarkRead, 7},
		{"ReactionAddCmd", ReactionAddCmd{userID: 8, messageID: 40, emoji: "👍"}, MsgTypeReactionAdd, 8},
		{"ReactionRemoveCmd", ReactionRemoveCmd{userID: 9, messageID: 41, emoji: "👎"}, MsgTypeReactionRemove, 9},
		{"VoiceJoinCmd", VoiceJoinCmd{userID: 10, channelID: 13}, MsgTypeVoiceJoin, 10},
		{"VoiceLeaveCmd", VoiceLeaveCmd{userID: 11}, MsgTypeVoiceLeave, 11},
		{"VoiceTokenRefreshCmd", VoiceTokenRefreshCmd{userID: 12}, MsgTypeVoiceTokenRefresh, 12},
		{"VoiceMuteCmd", VoiceMuteCmd{userID: 13, muted: true}, MsgTypeVoiceMute, 13},
		{"VoiceDeafenCmd", VoiceDeafenCmd{userID: 14, deafened: true}, MsgTypeVoiceDeafen, 14},
		{"VoiceCameraCmd", VoiceCameraCmd{userID: 15, enabled: true}, MsgTypeVoiceCamera, 15},
		{"VoiceScreenshareCmd", VoiceScreenshareCmd{userID: 16, enabled: true}, MsgTypeVoiceScreenshare, 16},
		{"VoiceE2EEAnnounceCmd", VoiceE2EEAnnounceCmd{userID: 17, publicKey: "abc"}, MsgTypeVoiceE2EEAnnounce, 17},
		{"VoiceE2EEOfferCmd", VoiceE2EEOfferCmd{userID: 18, targetUserID: 99}, MsgTypeVoiceE2EEOffer, 18},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.cmd.Type(); got != tt.wantType {
				t.Errorf("Type() = %q, want %q", got, tt.wantType)
			}
			if got := tt.cmd.UserID(); got != tt.wantUID {
				t.Errorf("UserID() = %d, want %d", got, tt.wantUID)
			}
		})
	}
}

func TestCommandChannelScoped(t *testing.T) {
	tests := []struct {
		name     string
		cmd      Command
		wantChID int64
		isScoped bool
	}{
		{"ChatSendCmd", ChatSendCmd{channelID: 100}, 100, true},
		{"TypingStartCmd", TypingStartCmd{channelID: 200}, 200, true},
		{"ChannelFocusCmd", ChannelFocusCmd{channelID: 300}, 300, true},
		{"MarkReadCmd", MarkReadCmd{channelID: 301}, 301, true},
		{"VoiceJoinCmd", VoiceJoinCmd{channelID: 400}, 400, true},
		{"PingCmd", PingCmd{userID: 1}, 0, false},
		{"VoiceLeaveCmd", VoiceLeaveCmd{userID: 1}, 0, false},
		{"PresenceUpdateCmd", PresenceUpdateCmd{userID: 1}, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cs, ok := tt.cmd.(ChannelScoped)
			if ok != tt.isScoped {
				t.Errorf("ChannelScoped assertion = %v, want %v", ok, tt.isScoped)
			}
			if ok && cs.ChannelID() != tt.wantChID {
				t.Errorf("ChannelID() = %d, want %d", cs.ChannelID(), tt.wantChID)
			}
		})
	}
}

func TestCommandConstructorParseValid(t *testing.T) {
	tests := []struct {
		name    string
		msgType string
		payload string
		checkFn func(t *testing.T, cmd Command)
	}{
		{
			name:    "ping",
			msgType: MsgTypePing,
			payload: `{}`,
			checkFn: func(t *testing.T, cmd Command) {
				if cmd.Type() != MsgTypePing {
					t.Errorf("Type() = %q, want %q", cmd.Type(), MsgTypePing)
				}
			},
		},
		{
			name:    "chat_send",
			msgType: MsgTypeChatSend,
			payload: `{"channel_id": 42, "content": "hello", "reply_to": 10, "attachments": ["a1"]}`,
			checkFn: func(t *testing.T, cmd Command) {
				cs := cmd.(ChatSendCmd)
				if cs.ChannelID() != 42 {
					t.Errorf("ChannelID() = %d, want 42", cs.ChannelID())
				}
				if cs.Content() != "hello" {
					t.Errorf("Content() = %q, want %q", cs.Content(), "hello")
				}
				if cs.ReplyTo() == nil || *cs.ReplyTo() != 10 {
					t.Errorf("ReplyTo() = %v, want 10", cs.ReplyTo())
				}
				if len(cs.Attachments()) != 1 || cs.Attachments()[0] != "a1" {
					t.Errorf("Attachments() = %v, want [a1]", cs.Attachments())
				}
			},
		},
		{
			name:    "chat_edit",
			msgType: MsgTypeChatEdit,
			payload: `{"message_id": 99, "content": "updated"}`,
			checkFn: func(t *testing.T, cmd Command) {
				ce := cmd.(ChatEditCmd)
				if ce.MessageID() != 99 {
					t.Errorf("MessageID() = %d, want 99", ce.MessageID())
				}
				if ce.Content() != "updated" {
					t.Errorf("Content() = %q, want %q", ce.Content(), "updated")
				}
			},
		},
		{
			name:    "chat_delete",
			msgType: MsgTypeChatDelete,
			payload: `{"message_id": 55}`,
			checkFn: func(t *testing.T, cmd Command) {
				cd := cmd.(ChatDeleteCmd)
				if cd.MessageID() != 55 {
					t.Errorf("MessageID() = %d, want 55", cd.MessageID())
				}
			},
		},
		{
			name:    "typing_start",
			msgType: MsgTypeTypingStart,
			payload: `{"channel_id": 7}`,
			checkFn: func(t *testing.T, cmd Command) {
				ts := cmd.(TypingStartCmd)
				if ts.ChannelID() != 7 {
					t.Errorf("ChannelID() = %d, want 7", ts.ChannelID())
				}
			},
		},
		{
			name:    "presence_update",
			msgType: MsgTypePresenceUpdate,
			payload: `{"status": "idle"}`,
			checkFn: func(t *testing.T, cmd Command) {
				pu := cmd.(PresenceUpdateCmd)
				if pu.Status() != "idle" {
					t.Errorf("Status() = %q, want %q", pu.Status(), "idle")
				}
			},
		},
		{
			name:    "channel_focus",
			msgType: MsgTypeChannelFocus,
			payload: `{"channel_id": 33}`,
			checkFn: func(t *testing.T, cmd Command) {
				cf := cmd.(ChannelFocusCmd)
				if cf.ChannelID() != 33 {
					t.Errorf("ChannelID() = %d, want 33", cf.ChannelID())
				}
			},
		},
		{
			name:    "mark_read",
			msgType: MsgTypeMarkRead,
			payload: `{"channel_id": 34}`,
			checkFn: func(t *testing.T, cmd Command) {
				mr := cmd.(MarkReadCmd)
				if mr.ChannelID() != 34 {
					t.Errorf("ChannelID() = %d, want 34", mr.ChannelID())
				}
			},
		},
		{
			name:    "reaction_add",
			msgType: MsgTypeReactionAdd,
			payload: `{"message_id": 77, "emoji": "🔥"}`,
			checkFn: func(t *testing.T, cmd Command) {
				ra := cmd.(ReactionAddCmd)
				if ra.MessageID() != 77 {
					t.Errorf("MessageID() = %d, want 77", ra.MessageID())
				}
				if ra.Emoji() != "🔥" {
					t.Errorf("Emoji() = %q, want %q", ra.Emoji(), "🔥")
				}
			},
		},
		{
			name:    "reaction_remove",
			msgType: MsgTypeReactionRemove,
			payload: `{"message_id": 88, "emoji": "👎"}`,
			checkFn: func(t *testing.T, cmd Command) {
				rr := cmd.(ReactionRemoveCmd)
				if rr.MessageID() != 88 {
					t.Errorf("MessageID() = %d, want 88", rr.MessageID())
				}
			},
		},
		{
			name:    "voice_join",
			msgType: MsgTypeVoiceJoin,
			payload: `{"channel_id": 50}`,
			checkFn: func(t *testing.T, cmd Command) {
				vj := cmd.(VoiceJoinCmd)
				if vj.ChannelID() != 50 {
					t.Errorf("ChannelID() = %d, want 50", vj.ChannelID())
				}
			},
		},
		{
			name:    "voice_leave",
			msgType: MsgTypeVoiceLeave,
			payload: `{}`,
			checkFn: func(t *testing.T, cmd Command) {
				if cmd.Type() != MsgTypeVoiceLeave {
					t.Errorf("Type() = %q, want %q", cmd.Type(), MsgTypeVoiceLeave)
				}
			},
		},
		{
			name:    "voice_token_refresh",
			msgType: MsgTypeVoiceTokenRefresh,
			payload: `{}`,
			checkFn: func(t *testing.T, cmd Command) {
				if cmd.Type() != MsgTypeVoiceTokenRefresh {
					t.Errorf("Type() = %q, want %q", cmd.Type(), MsgTypeVoiceTokenRefresh)
				}
			},
		},
		{
			name:    "voice_mute",
			msgType: MsgTypeVoiceMute,
			payload: `{"muted": true}`,
			checkFn: func(t *testing.T, cmd Command) {
				vm := cmd.(VoiceMuteCmd)
				if !vm.Muted() {
					t.Error("Muted() = false, want true")
				}
			},
		},
		{
			name:    "voice_deafen",
			msgType: MsgTypeVoiceDeafen,
			payload: `{"deafened": true}`,
			checkFn: func(t *testing.T, cmd Command) {
				vd := cmd.(VoiceDeafenCmd)
				if !vd.Deafened() {
					t.Error("Deafened() = false, want true")
				}
			},
		},
		{
			name:    "voice_camera",
			msgType: MsgTypeVoiceCamera,
			payload: `{"enabled": true}`,
			checkFn: func(t *testing.T, cmd Command) {
				vc := cmd.(VoiceCameraCmd)
				if !vc.Enabled() {
					t.Error("Enabled() = false, want true")
				}
			},
		},
		{
			name:    "voice_screenshare",
			msgType: MsgTypeVoiceScreenshare,
			payload: `{"enabled": false}`,
			checkFn: func(t *testing.T, cmd Command) {
				vs := cmd.(VoiceScreenshareCmd)
				if vs.Enabled() {
					t.Error("Enabled() = true, want false")
				}
			},
		},
		{
			name:    "voice_e2ee_announce",
			msgType: MsgTypeVoiceE2EEAnnounce,
			payload: `{"public_key": "dGVzdA=="}`,
			checkFn: func(t *testing.T, cmd Command) {
				va := cmd.(VoiceE2EEAnnounceCmd)
				if va.PublicKey() != "dGVzdA==" {
					t.Errorf("PublicKey() = %q, want %q", va.PublicKey(), "dGVzdA==")
				}
			},
		},
		{
			name:    "voice_e2ee_offer",
			msgType: MsgTypeVoiceE2EEOffer,
			payload: `{"target_user_id": 99, "encrypted_key": "abc", "iv": "def"}`,
			checkFn: func(t *testing.T, cmd Command) {
				vo := cmd.(VoiceE2EEOfferCmd)
				if vo.TargetUserID() != 99 {
					t.Errorf("TargetUserID() = %d, want 99", vo.TargetUserID())
				}
				if vo.EncryptedKey() != "abc" {
					t.Errorf("EncryptedKey() = %q, want %q", vo.EncryptedKey(), "abc")
				}
				if vo.IV() != "def" {
					t.Errorf("IV() = %q, want %q", vo.IV(), "def")
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctor, ok := commandConstructors[tt.msgType]
			if !ok {
				t.Fatalf("no constructor for %q", tt.msgType)
			}
			cmd, err := ctor(42, "req-1", json.RawMessage(tt.payload))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if cmd.UserID() != 42 {
				t.Errorf("UserID() = %d, want 42", cmd.UserID())
			}
			tt.checkFn(t, cmd)
		})
	}
}

func TestCommandConstructorRejectsInvalidJSON(t *testing.T) {
	// All constructors that parse a payload should reject garbage JSON.
	typesWithPayload := []string{
		MsgTypeChatSend,
		MsgTypeChatEdit,
		MsgTypeChatDelete,
		MsgTypeTypingStart,
		MsgTypePresenceUpdate,
		MsgTypeChannelFocus,
		MsgTypeMarkRead,
		MsgTypeReactionAdd,
		MsgTypeReactionRemove,
		MsgTypeVoiceJoin,
		MsgTypeVoiceMute,
		MsgTypeVoiceDeafen,
		MsgTypeVoiceCamera,
		MsgTypeVoiceScreenshare,
		MsgTypeVoiceE2EEAnnounce,
		MsgTypeVoiceE2EEOffer,
	}
	badJSON := json.RawMessage(`{not valid json`)
	for _, msgType := range typesWithPayload {
		t.Run(msgType, func(t *testing.T) {
			ctor := commandConstructors[msgType]
			_, err := ctor(1, "req-1", badJSON)
			if err == nil {
				t.Errorf("expected error for invalid JSON, got nil")
			}
		})
	}
}

func TestCommandConstructorNoPayloadTypes(t *testing.T) {
	// These types ignore the payload — they should succeed with nil.
	noPayloadTypes := []string{
		MsgTypePing,
		MsgTypeVoiceLeave,
		MsgTypeVoiceTokenRefresh,
	}
	for _, msgType := range noPayloadTypes {
		t.Run(msgType, func(t *testing.T) {
			ctor := commandConstructors[msgType]
			cmd, err := ctor(5, "", nil)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if cmd.UserID() != 5 {
				t.Errorf("UserID() = %d, want 5", cmd.UserID())
			}
		})
	}
}

func TestCommandChatSendReqID(t *testing.T) {
	ctor := commandConstructors[MsgTypeChatSend]
	cmd, err := ctor(1, "abc-123", json.RawMessage(`{"channel_id": 1, "content": "hi"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	cs := cmd.(ChatSendCmd)
	if cs.ReqID() != "abc-123" {
		t.Errorf("ReqID() = %q, want %q", cs.ReqID(), "abc-123")
	}
}

func TestCommandChatSendNilReplyTo(t *testing.T) {
	ctor := commandConstructors[MsgTypeChatSend]
	cmd, err := ctor(1, "", json.RawMessage(`{"channel_id": 1, "content": "hi"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	cs := cmd.(ChatSendCmd)
	if cs.ReplyTo() != nil {
		t.Errorf("ReplyTo() = %v, want nil", cs.ReplyTo())
	}
}

func TestCommandAttachmentsDefensiveCopy(t *testing.T) {
	cmd := ChatSendCmd{attachments: []string{"a", "b"}}
	got := cmd.Attachments()
	got[0] = "mutated"
	if cmd.attachments[0] == "mutated" {
		t.Error("Attachments() did not return a defensive copy")
	}
}
