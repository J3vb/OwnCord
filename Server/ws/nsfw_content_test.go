package ws

import "testing"

// TestNSFW_EveryServerFrameKindIsClassified is contentBearingKinds'
// completeness guard: every server->client wire name protocol/schema.json
// registers must be listed as content or metadata, so a new frame
// (B5-8..B5-10) has to choose rather than silently defaulting to whichever
// side is more convenient. Reads the constant names by their known value set
// rather than reflection over message_types.go (generated, no exported
// registry), so the fixture is exactly the wire names the protocol package
// emits today.
func TestNSFW_EveryServerFrameKindIsClassified(t *testing.T) {
	serverToClient := []string{
		MsgTypeAuthOK, MsgTypeAuthError, MsgTypeReady, MsgTypeChatMessage,
		MsgTypeChatSendOK, MsgTypeChatEdited, MsgTypeChatDeleted, MsgTypeChatBulkDeleted,
		MsgTypeReactionUpdate, MsgTypeTyping, MsgTypePresence, MsgTypeChannelCreate,
		MsgTypeChannelUpdate, MsgTypeChannelDelete, MsgTypeVoiceState, MsgTypeVoiceConfig,
		MsgTypeVoiceToken, MsgTypeVoiceLeaveBC, MsgTypeVoiceMoved, MsgTypeVoiceDisconnected,
		MsgTypeMemberJoin, MsgTypeMemberUpdate, MsgTypeUserUpdate, MsgTypeMemberBan,
		MsgTypeRolesUpdate, MsgTypeEmojiUpdate, MsgTypeServerRestart, MsgTypeError,
		MsgTypePong, MsgTypeDMChannelOpen, MsgTypeDMChannelClose, MsgTypeDMRequest,
		MsgTypeCallIncoming, MsgTypeCallDeclined, MsgTypeVoiceE2EEAnnounceBC,
		MsgTypeVoiceE2EEOfferRelay, MsgTypeCommandReply, MsgTypePluginBroadcast,
		MsgTypeNSFWAck,
	}
	if len(serverToClient) != 39 {
		t.Fatalf("fixture lists %d server->client kinds, want 39 (protocol/schema.json's "+
			"count as of this test) — a type was added or removed without updating this "+
			"fixture; update the list and the count together", len(serverToClient))
	}
	for _, kind := range serverToClient {
		if _, ok := contentBearingKinds[kind]; !ok {
			t.Errorf("server->client kind %q is not classified in contentBearingKinds "+
				"(ws/nsfw_content.go) — add it as content or metadata", kind)
		}
	}
	// The reverse direction: nothing in the table names a kind that is not
	// actually registered, so a renamed or removed type does not leave a
	// stale, meaningless entry behind.
	registered := make(map[string]bool, len(serverToClient))
	for _, kind := range serverToClient {
		registered[kind] = true
	}
	for kind := range contentBearingKinds {
		if !registered[kind] {
			t.Errorf("contentBearingKinds classifies %q, which is not a registered server->client kind", kind)
		}
	}
}
