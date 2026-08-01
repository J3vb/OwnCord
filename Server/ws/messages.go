package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
)

// envelope is the common wrapper for all WebSocket messages.
type envelope struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// wsMsg is the generic envelope for outbound WebSocket messages.
type wsMsg struct {
	Type    string `json:"type"`
	ID      string `json:"id,omitempty"`
	Payload any    `json:"payload,omitempty"`
}

// ---------------------------------------------------------------------------
// Payload structs — one per outbound message type.
// ---------------------------------------------------------------------------

type presencePayload struct {
	UserID int64  `json:"user_id"`
	Status string `json:"status"`
	// CustomStatus is the user's free-text status line. Always present (null
	// when unset) rather than omitempty: a client has to be able to tell
	// "cleared it" from "this event does not mention it", and every presence
	// broadcast carries the current value.
	CustomStatus *string `json:"custom_status"`
}

type memberUserPayload struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	Role     string  `json:"role"`
	// DisplayName is the nickname to render instead of Username. Omitted when
	// unset; clients fall back to Username. Username stays on the wire because
	// it is still the unique handle mentions resolve against.
	DisplayName *string `json:"display_name,omitempty"`
	// IdentityPublicKey is the user's long-term E2EE identity public key
	// (base64), pinned by peers on first sight (F3 TOFU). Omitted when the
	// user has not published one (legacy client) and in payloads that do not
	// carry it (e.g. chat_message).
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
}

type memberJoinPayload struct {
	User memberUserPayload `json:"user"`
	// Status is the viewer-safe presence the connecting user comes online as
	// (db.BroadcastStatus of the ConnectStatus-mapped value): an invisible
	// connector reports "offline" here, never their true chosen status. This
	// is BroadcastToAll, not the channel-scoped presence path, so every
	// connected client — invisible or not — receives it; the client MUST
	// render members from this field rather than assuming "online" just
	// because a member_join arrived, or an invisible user renders online
	// until the (droppable, low-priority) presence correction catches up.
	Status string `json:"status"`
}

type chatMessagePayload struct {
	ID          int64             `json:"id"`
	ChannelID   int64             `json:"channel_id"`
	User        memberUserPayload `json:"user"`
	Content     string            `json:"content"`
	ReplyTo     *int64            `json:"reply_to"`
	Timestamp   string            `json:"timestamp"`
	Attachments []map[string]any  `json:"attachments"`
	Reactions   []any             `json:"reactions"`
	Pinned      bool              `json:"pinned"`
	// Mentions carries the server-resolved user ids; MentionsEveryone reports
	// an @everyone/@here that cleared MENTION_EVERYONE. Clients highlight from
	// these instead of re-parsing the content.
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
}

type memberUpdatePayload struct {
	UserID int64  `json:"user_id"`
	Role   string `json:"role"`
}

type userUpdatePayload struct {
	UserID   int64   `json:"user_id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	// DisplayName and About are always present (null = cleared) so a profile
	// edit that removes either one is distinguishable from one that leaves it
	// alone — user_update replaces the client's copy wholesale.
	DisplayName *string `json:"display_name"`
	About       *string `json:"about"`
	// IdentityPublicKey mirrors memberUserPayload — carried so peers can
	// detect an identity-key change (TOFU mismatch) as it happens.
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
}

type memberBanPayload struct {
	UserID int64 `json:"user_id"`
}

// rolesUpdatePayload carries the whole role list rather than a delta. The
// client's role state is a flat list keyed by id that drives name colors and
// permission gating; replacing it wholesale is both smaller to reason about
// than a patch protocol and immune to a dropped intermediate event leaving a
// deleted role on screen.
type rolesUpdatePayload struct {
	Roles []db.Role `json:"roles"`
}

// emojiInfo is the client-facing shape of one custom emoji: enough to render
// it and to spell it. The storage id and mime type stay server-side -- the
// image route is the only thing that needs them.
type emojiInfo struct {
	ID        int64  `json:"id"`
	Shortcode string `json:"shortcode"`
	URL       string `json:"url"`
}

// emojiUpdatePayload carries the whole emoji set, for the same reason
// rolesUpdatePayload carries the whole role list: the client's emoji state is a
// flat map keyed by shortcode that message rendering, the picker and reaction
// pills all read, and a wholesale replace cannot leave a deleted emoji on
// screen after a dropped event.
type emojiUpdatePayload struct {
	Emoji []emojiInfo `json:"emoji"`
}

type chatSendOKPayload struct {
	MessageID int64  `json:"message_id"`
	Timestamp string `json:"timestamp"`
}

type chatEditedPayload struct {
	MessageID int64  `json:"message_id"`
	ChannelID int64  `json:"channel_id"`
	Content   string `json:"content"`
	EditedAt  string `json:"edited_at"`
	// Mentions/MentionsEveryone are re-resolved from the edited content, so an
	// edit that adds or drops a mention updates the highlight too.
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
}

type chatDeletedPayload struct {
	MessageID int64 `json:"message_id"`
	ChannelID int64 `json:"channel_id"`
}

type chatBulkDeletedPayload struct {
	ChannelID int64   `json:"channel_id"`
	IDs       []int64 `json:"ids"`
}

type reactionUpdatePayload struct {
	MessageID int64  `json:"message_id"`
	ChannelID int64  `json:"channel_id"`
	Emoji     string `json:"emoji"`
	UserID    int64  `json:"user_id"`
	Action    string `json:"action"`
}

type typingPayload struct {
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
}

type voiceStatePayload struct {
	ChannelID   int64  `json:"channel_id"`
	UserID      int64  `json:"user_id"`
	Username    string `json:"username"`
	Muted       bool   `json:"muted"`
	Deafened    bool   `json:"deafened"`
	Speaking    bool   `json:"speaking"`
	Camera      bool   `json:"camera"`
	Screenshare bool   `json:"screenshare"`
	// ServerMuted/ServerDeafened are moderator-imposed. Muted/Deafened are
	// always set alongside them, so a client that ignores these two still
	// renders the user as silenced; they exist so the UI can distinguish a
	// self-mute from one the user may not lift.
	ServerMuted    bool `json:"server_muted"`
	ServerDeafened bool `json:"server_deafened"`
}

// voiceMovedPayload tells one client its moderator moved it to another voice
// channel. The client tears down its LiveKit session and re-joins to_channel_id
// through the normal voice_join path.
type voiceMovedPayload struct {
	ToChannelID int64 `json:"to_channel_id"`
}

// voiceDisconnectedPayload tells one client a moderator removed it from voice.
type voiceDisconnectedPayload struct {
	ChannelID int64  `json:"channel_id"`
	Reason    string `json:"reason"`
}

type voiceConfigPayload struct {
	ChannelID       int64  `json:"channel_id"`
	Quality         string `json:"quality"`
	Bitrate         int    `json:"bitrate"`
	MaxUsers        int    `json:"max_users"`
	ThresholdMode   string `json:"threshold_mode"`
	MixingThreshold int    `json:"mixing_threshold"`
	TopSpeakers     int    `json:"top_speakers"`
}

type voiceTokenPayload struct {
	ChannelID   int64  `json:"channel_id"`
	Token       string `json:"token"`
	URL         string `json:"url"`
	DirectURL   string `json:"direct_url"`
	IsKeyHolder bool   `json:"is_key_holder"`
}

// ── Voice E2EE (client-side ECDH key exchange) ─────────────────────────────

// voiceE2EEAnnounceBroadcast is the server→client relay with user_id added.
// Signature is the sender's identity-key signature over the ephemeral key
// (F3 TOFU) — relayed verbatim, omitted for legacy announces without one.
type voiceE2EEAnnounceBroadcast struct {
	UserID    int64  `json:"user_id"`
	PublicKey string `json:"public_key"`
	Signature string `json:"signature,omitempty"`
}

// voiceE2EEOfferRelay is the server→client relay with from_user_id.
type voiceE2EEOfferRelay struct {
	FromUserID   int64  `json:"from_user_id"`
	EncryptedKey string `json:"encrypted_key"`
	IV           string `json:"iv"`
}

type voiceLeavePayload struct {
	ChannelID int64 `json:"channel_id"`
	UserID    int64 `json:"user_id"`
}

type channelPayload struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	Topic    string `json:"topic"`
	Position int    `json:"position"`
	// SlowMode lets the client pre-disable the composer for the cooldown
	// instead of accepting a message the server will refuse with SLOW_MODE.
	// Seconds; 0 means off.
	SlowMode int `json:"slow_mode"`
	// NSFW marks the channel as possibly carrying sensitive content. It is
	// shipped so clients can gate or label it; the server applies no content
	// behaviour of its own to a flagged channel.
	NSFW bool `json:"nsfw"`
	// Voice capacity limits (0 = unlimited), the same values the voice-join
	// path enforces with CHANNEL_FULL / VIDEO_LIMIT. Sent so the sidebar can
	// show "3/5" and the client can explain a refusal it could have predicted.
	VoiceMaxUsers int `json:"voice_max_users"`
	VoiceMaxVideo int `json:"voice_max_video"`
}

// channelPayloadFrom narrows a channel row to the wire shape shared by the
// channel_create and channel_update broadcasts. One constructor so the two
// events can never disagree about which fields a client is told about.
func channelPayloadFrom(ch *db.Channel) channelPayload {
	return channelPayload{
		ID:            ch.ID,
		Name:          ch.Name,
		Type:          ch.Type,
		Category:      ch.Category,
		Topic:         ch.Topic,
		Position:      ch.Position,
		SlowMode:      ch.SlowMode,
		NSFW:          ch.NSFW,
		VoiceMaxUsers: ch.VoiceMaxUsers,
		VoiceMaxVideo: ch.VoiceMaxVideo,
	}
}

type channelDeletePayload struct {
	ID int64 `json:"id"`
}

type serverRestartPayload struct {
	Reason       string `json:"reason"`
	DelaySeconds int    `json:"delay_seconds"`
}

// callSignalPayload carries an ephemeral DM call signal (call_incoming /
// call_declined). There is no call id: the "call" is presence in the DM's
// voice channel, so channel_id plus who is signalling is the whole state.
type callSignalPayload struct {
	ChannelID int64  `json:"channel_id"`
	FromUser  int64  `json:"from_user"`
	Username  string `json:"username"`
}

// ---------------------------------------------------------------------------
// Builder helpers (kept as maps per task spec).
// ---------------------------------------------------------------------------

// buildJSON marshals v into a JSON byte slice, logging on failure.
func buildJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		slog.Error("buildJSON marshal failed", "error", err, "type", fmt.Sprintf("%T", v))
		// Fallback: send a generic error rather than panicking.
		b, _ = json.Marshal(map[string]string{"type": "error", "message": "internal marshal error"})
	}
	return b
}

// buildErrorMsg produces an error envelope with the given code and message.
func buildErrorMsg(code, message string) []byte {
	return buildJSON(map[string]any{
		"type": MsgTypeError,
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// buildErrorMsgWithID produces an error envelope that echoes the originating
// command's request id, so the client can correlate the failure with the
// specific command it sent (e.g. mark an optimistic chat_send row as failed).
// When reqID is empty it falls back to the id-less envelope.
func buildErrorMsgWithID(code, message, reqID string) []byte {
	if reqID == "" {
		return buildErrorMsg(code, message)
	}
	return buildJSON(map[string]any{
		"type": MsgTypeError,
		"id":   reqID,
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// buildAuthError produces an auth_error envelope per PROTOCOL.md.
// The client treats this type as non-recoverable and stops reconnecting.
func buildAuthError(message string) []byte {
	return buildJSON(map[string]any{
		"type": MsgTypeAuthError,
		"payload": map[string]string{
			"message": message,
		},
	})
}

// ---------------------------------------------------------------------------
// Typed message builders.
// ---------------------------------------------------------------------------

// buildPresenceMsg constructs a presence broadcast payload.
//
// status is taken verbatim: callers decide whose eyes the payload is for and
// pass db.BroadcastStatus(status) for everyone but the owner. Keeping the
// mapping out of the builder is deliberate — a builder that always collapsed
// invisible could never produce the owner's own true-state message.
func buildPresenceMsg(userID int64, status string, customStatus *string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypePresence,
		Payload: presencePayload{UserID: userID, Status: status, CustomStatus: customStatus},
	})
}

// buildMemberJoin constructs a member_join broadcast for when a user comes
// online. user.Status is expected to already carry the ConnectStatus-mapped
// value the caller settled the session on (see serve.go's applyConnectStatus,
// which runs before this); Status here applies the BroadcastStatus collapse
// so an invisible connector's member_join reports "offline" like every other
// payload another user can see, instead of the raw chosen status.
func buildMemberJoin(user *db.User, roleName string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeMemberJoin,
		Payload: memberJoinPayload{
			User: memberUserPayload{
				ID:                user.ID,
				Username:          user.Username,
				Avatar:            user.Avatar,
				Role:              roleName,
				DisplayName:       user.DisplayName,
				IdentityPublicKey: user.IdentityPublicKey,
			},
			Status: db.BroadcastStatus(user.Status),
		},
	})
}

// chatMessageArgs is the input to buildChatMessage. It is a struct rather than
// a positional list because the payload has outgrown readable call sites.
type chatMessageArgs struct {
	MsgID            int64
	ChannelID        int64
	UserID           int64
	Username         string
	Avatar           *string
	DisplayName      *string
	RoleName         string
	Content          string
	Timestamp        string
	ReplyTo          *int64
	Attachments      []map[string]any
	Mentions         []int64
	MentionsEveryone bool
}

// buildChatMessage constructs a chat_message broadcast envelope.
// Includes role in user object and empty reactions array for consistency with REST API.
func buildChatMessage(a chatMessageArgs) []byte {
	attachments := a.Attachments
	if attachments == nil {
		attachments = []map[string]any{}
	}
	mentions := a.Mentions
	if mentions == nil {
		mentions = []int64{}
	}
	return buildJSON(wsMsg{
		Type: MsgTypeChatMessage,
		Payload: chatMessagePayload{
			ID:        a.MsgID,
			ChannelID: a.ChannelID,
			User: memberUserPayload{
				ID:          a.UserID,
				Username:    a.Username,
				Avatar:      a.Avatar,
				Role:        a.RoleName,
				DisplayName: a.DisplayName,
			},
			Content:          a.Content,
			ReplyTo:          a.ReplyTo,
			Timestamp:        a.Timestamp,
			Attachments:      attachments,
			Reactions:        []any{},
			Pinned:           false,
			Mentions:         mentions,
			MentionsEveryone: a.MentionsEveryone,
		},
	})
}

// buildMemberUpdate constructs a member_update broadcast per PROTOCOL.md.
func buildMemberUpdate(userID int64, roleName string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeMemberUpdate,
		Payload: memberUpdatePayload{UserID: userID, Role: roleName},
	})
}

// UserUpdate is the profile snapshot a user_update broadcast carries. It is a
// struct rather than five positional arguments because every field is a
// nullable string and a swapped pair would compile.
type UserUpdate struct {
	UserID            int64
	Username          string
	Avatar            *string
	DisplayName       *string
	About             *string
	IdentityPublicKey *string
}

// buildUserUpdate constructs a user_update broadcast for profile changes.
func buildUserUpdate(u UserUpdate) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeUserUpdate,
		Payload: userUpdatePayload(u),
	})
}

// buildMemberBan constructs a member_ban broadcast per PROTOCOL.md.
func buildMemberBan(userID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeMemberBan,
		Payload: memberBanPayload{UserID: userID},
	})
}

// buildRolesUpdate constructs a roles_update broadcast carrying the full role
// list, ordered highest position first exactly like the ready payload's.
func buildRolesUpdate(roles []*db.Role) []byte {
	flat := make([]db.Role, 0, len(roles))
	for _, r := range roles {
		if r != nil {
			flat = append(flat, *r)
		}
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeRolesUpdate,
		Payload: rolesUpdatePayload{Roles: flat},
	})
}

// buildEmojiUpdate constructs an emoji_update broadcast carrying the full
// custom-emoji set, ordered the way the server listed it.
func buildEmojiUpdate(list []*db.Emoji) []byte {
	flat := make([]emojiInfo, 0, len(list))
	for _, e := range list {
		if e == nil {
			continue
		}
		flat = append(flat, emojiInfo{
			ID:        e.ID,
			Shortcode: e.Shortcode,
			URL:       service.EmojiImageURL(e.ID),
		})
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeEmojiUpdate,
		Payload: emojiUpdatePayload{Emoji: flat},
	})
}

// buildChatSendOK constructs a chat_send_ok ack.
func buildChatSendOK(requestID string, msgID int64, timestamp string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChatSendOK,
		ID:      requestID,
		Payload: chatSendOKPayload{MessageID: msgID, Timestamp: timestamp},
	})
}

// buildChatEdited constructs a chat_edited broadcast.
func buildChatEdited(msgID, channelID int64, content, editedAt string, mentions []int64, mentionsEveryone bool) []byte {
	if mentions == nil {
		mentions = []int64{}
	}
	return buildJSON(wsMsg{
		Type: MsgTypeChatEdited,
		Payload: chatEditedPayload{
			MessageID:        msgID,
			ChannelID:        channelID,
			Content:          content,
			EditedAt:         editedAt,
			Mentions:         mentions,
			MentionsEveryone: mentionsEveryone,
		},
	})
}

// buildChatDeleted constructs a chat_deleted broadcast.
func buildChatDeleted(msgID, channelID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChatDeleted,
		Payload: chatDeletedPayload{MessageID: msgID, ChannelID: channelID},
	})
}

// buildChatBulkDeleted constructs a chat_bulk_deleted broadcast. ids is
// emitted as an empty array rather than null when nothing was purged, so
// clients can iterate it unconditionally.
func buildChatBulkDeleted(channelID int64, ids []int64) []byte {
	if ids == nil {
		ids = []int64{}
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeChatBulkDeleted,
		Payload: chatBulkDeletedPayload{ChannelID: channelID, IDs: ids},
	})
}

// buildReactionUpdate constructs a reaction_update broadcast.
func buildReactionUpdate(msgID, channelID, userID int64, emoji, action string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeReactionUpdate,
		Payload: reactionUpdatePayload{
			MessageID: msgID,
			ChannelID: channelID,
			Emoji:     emoji,
			UserID:    userID,
			Action:    action,
		},
	})
}

// buildTypingMsg constructs a typing broadcast.
func buildTypingMsg(channelID, userID int64, username string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeTyping,
		Payload: typingPayload{
			ChannelID: channelID,
			UserID:    userID,
			Username:  username,
		},
	})
}

// buildVoiceState constructs a voice_state server->client broadcast.
func buildVoiceState(state db.VoiceState) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceState,
		Payload: voiceStatePayload{
			ChannelID:   state.ChannelID,
			UserID:      state.UserID,
			Username:    state.Username,
			Muted:       state.Muted,
			Deafened:    state.Deafened,
			Speaking:    state.Speaking,
			Camera:      state.Camera,
			Screenshare: state.Screenshare,

			ServerMuted:    state.ServerMuted,
			ServerDeafened: state.ServerDeafened,
		},
	})
}

// buildVoiceMoved constructs a voice_moved message for the moved client.
func buildVoiceMoved(toChannelID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceMoved,
		Payload: voiceMovedPayload{ToChannelID: toChannelID},
	})
}

// buildVoiceDisconnected constructs a voice_disconnected message for the
// client a moderator removed from voice.
func buildVoiceDisconnected(channelID int64, reason string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceDisconnected,
		Payload: voiceDisconnectedPayload{ChannelID: channelID, Reason: reason},
	})
}

// buildVoiceConfig constructs a voice_config message sent after voice_join acceptance.
func buildVoiceConfig(channelID int64, quality string, bitrate int, maxUsers int) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceConfig,
		Payload: voiceConfigPayload{
			ChannelID:       channelID,
			Quality:         quality,
			Bitrate:         bitrate,
			MaxUsers:        maxUsers,
			ThresholdMode:   "top_speakers",
			MixingThreshold: 0,
			TopSpeakers:     5,
		},
	})
}

// buildVoiceToken constructs a voice_token message with a LiveKit token and URL.
// url is the proxy path ("/livekit") for remote clients; direct_url is the raw
// LiveKit URL (e.g. "ws://localhost:7880") for localhost clients.
func buildVoiceToken(channelID int64, token string, proxyPath string, directURL string, isKeyHolder bool) []byte { //nolint:unparam // kept configurable for proxy path flexibility
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceToken,
		Payload: voiceTokenPayload{
			ChannelID:   channelID,
			Token:       token,
			URL:         proxyPath,
			DirectURL:   directURL,
			IsKeyHolder: isKeyHolder,
		},
	})
}

// buildVoiceE2EEAnnounce constructs a voice_e2ee_announce server→client relay.
// signature may be "" (legacy announce) — the field is then omitted.
func buildVoiceE2EEAnnounce(userID int64, publicKey, signature string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceE2EEAnnounceBC,
		Payload: voiceE2EEAnnounceBroadcast{
			UserID:    userID,
			PublicKey: publicKey,
			Signature: signature,
		},
	})
}

// buildVoiceE2EEOffer constructs a voice_e2ee_offer server→client relay.
func buildVoiceE2EEOffer(fromUserID int64, encryptedKey, iv string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceE2EEOfferRelay,
		Payload: voiceE2EEOfferRelay{
			FromUserID:   fromUserID,
			EncryptedKey: encryptedKey,
			IV:           iv,
		},
	})
}

// buildVoiceLeave constructs a voice_leave server->client broadcast.
func buildVoiceLeave(channelID, userID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceLeaveBC,
		Payload: voiceLeavePayload{ChannelID: channelID, UserID: userID},
	})
}

// buildChannelCreate constructs a channel_create broadcast.
func buildChannelCreate(ch *db.Channel) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChannelCreate,
		Payload: channelPayloadFrom(ch),
	})
}

// buildChannelUpdate constructs a channel_update broadcast.
func buildChannelUpdate(ch *db.Channel) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChannelUpdate,
		Payload: channelPayloadFrom(ch),
	})
}

// buildChannelDelete constructs a channel_delete broadcast.
func buildChannelDelete(channelID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChannelDelete,
		Payload: channelDeletePayload{ID: channelID},
	})
}

// buildDMChannelOpen constructs a dm_channel_open event for one viewer.
//
// The payload is a db.DMChannelInfo, the same shape the REST list and the
// ready payload carry, so a client has exactly one DM shape to parse. It is
// built per viewer rather than once per channel because `recipient` and
// `recipients` are both defined relative to who is reading them.
func buildDMChannelOpen(info db.DMChannelInfo) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeDMChannelOpen,
		Payload: info,
	})
}

// buildDMChannelOpenFor constructs a dm_channel_open event announcing a 1:1 DM
// to the user on the other end of it. Returns nil if recipient is nil to avoid
// a panic on dereferencing.
func buildDMChannelOpenFor(channelID int64, recipient *db.User, viewerID int64) []byte {
	if recipient == nil {
		slog.Warn("buildDMChannelOpenFor called with nil recipient", "channel_id", channelID)
		return nil
	}
	avatarStr := ""
	if recipient.Avatar != nil {
		avatarStr = *recipient.Avatar
	}
	displayName := ""
	if recipient.DisplayName != nil {
		displayName = *recipient.DisplayName
	}
	other := db.DMUser{
		ID:          recipient.ID,
		Username:    recipient.Username,
		Avatar:      avatarStr,
		Status:      db.StatusForViewer(recipient.Status, recipient.ID, viewerID),
		DisplayName: displayName,
	}
	return buildDMChannelOpen(db.DMChannelInfo{
		ChannelID:  channelID,
		Recipient:  other,
		Recipients: []db.DMUser{other},
	})
}

// buildCallSignal constructs a call_incoming or call_declined frame.
func buildCallSignal(msgType string, channelID, fromUserID int64, username string) []byte {
	return buildJSON(wsMsg{
		Type: msgType,
		Payload: callSignalPayload{
			ChannelID: channelID,
			FromUser:  fromUserID,
			Username:  username,
		},
	})
}

// buildServerRestartMsg constructs a server_restart broadcast.
func buildServerRestartMsg(reason string, delaySeconds int) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeServerRestart,
		Payload: serverRestartPayload{
			Reason:       reason,
			DelaySeconds: delaySeconds,
		},
	})
}

// parseChannelID safely extracts channel_id from a raw payload map.
func parseChannelID(payload json.RawMessage) (int64, error) {
	var p struct {
		ChannelID json.Number `json:"channel_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return 0, err
	}
	id, err := p.ChannelID.Int64()
	if err != nil {
		return 0, fmt.Errorf("channel_id must be integer: %w", err)
	}
	return id, nil
}
