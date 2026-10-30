package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

type envelope struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type wsMsg struct {
	Type    string `json:"type"`
	ID      string `json:"id,omitempty"`
	Payload any    `json:"payload,omitempty"`
}

type presencePayload struct {
	UserID int64  `json:"user_id"`
	Status string `json:"status"`
	// CustomStatus is the free-text status line. Always present (null when unset),
	// not omitempty: a client must tell "cleared" from "not mentioned".
	CustomStatus *string `json:"custom_status"`
	// Activity is the game being played. Always present (null when none) like
	// CustomStatus; blanked for everyone but the owner while invisible.
	Activity *gameActivity `json:"activity"`
	// Listening is the song being listened to; same rules as Activity.
	Listening *listeningActivity `json:"listening"`
}

type memberUserPayload struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	Role     string  `json:"role"`
	// DisplayName is the nickname to render instead of Username (omitted when unset).
	// Username stays on the wire as the unique handle mentions resolve against.
	DisplayName *string `json:"display_name,omitempty"`
	// IdentityPublicKey is the user's long-term E2EE identity public key (base64),
	// pinned by peers on first sight. Omitted when unpublished and in payloads that
	// do not carry it (e.g. chat_message).
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
}

// memberJoinUser is the member_join user object: memberUserPayload plus the
// profile fields the member list shows. Separate because memberUserPayload is also
// chat_message.user, which must not carry them.
type memberJoinUser struct {
	memberUserPayload
	About     *string `json:"about"`
	CreatedAt string  `json:"created_at"`
	// RoleIDs is every held role, top first; Role stays the top role's name. Omitted
	// when the holder list was not read.
	RoleIDs []int64 `json:"role_ids,omitempty"`
	// Banner (a /api/v1/files/<id> path) and BannerColor are omitted when unset.
	Banner      *string `json:"banner,omitempty"`
	BannerColor *string `json:"banner_color,omitempty"`
}

type memberJoinPayload struct {
	User memberJoinUser `json:"user"`
	// Status is the viewer-safe presence the connecting user comes online as
	// (db.BroadcastStatus of the ConnectStatus-mapped value): an invisible connector
	// reports "offline", never their true status. This is BroadcastToAll, so every
	// client receives it, and the client must render members from this field rather
	// than assume online, or an invisible user shows online until the droppable
	// low-priority presence correction arrives.
	Status string `json:"status"`
}

type memberUpdatePayload struct {
	UserID int64  `json:"user_id"`
	Role   string `json:"role"`
	// RoleIDs is every held role, top first; Role is the top role's name. Omitted
	// when the holder list was not read.
	RoleIDs []int64 `json:"role_ids,omitempty"`
}

type userUpdatePayload struct {
	UserID   int64   `json:"user_id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	// DisplayName and About are always present (null = cleared) so removing one is
	// distinguishable from leaving it alone; user_update replaces the client's copy.
	DisplayName *string `json:"display_name"`
	About       *string `json:"about"`
	// IdentityPublicKey mirrors memberUserPayload so peers can detect an identity-key change.
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
	// Banner and BannerColor are always present (null = cleared), like DisplayName and About.
	Banner      *string `json:"banner"`
	BannerColor *string `json:"banner_color"`
}

type memberBanPayload struct {
	UserID int64 `json:"user_id"`
}

// rolesUpdatePayload carries the whole role list, not a delta: replacing the
// client's flat role list wholesale is simpler than a patch protocol and immune to
// a dropped intermediate event leaving a deleted role on screen.
type rolesUpdatePayload struct {
	Roles []db.Role `json:"roles"`
}

// emojiInfo is the client-facing shape of one custom emoji. The storage id and
// mime type stay server-side.
type emojiInfo struct {
	ID        int64  `json:"id"`
	Shortcode string `json:"shortcode"`
	URL       string `json:"url"`
}

// emojiUpdatePayload carries the whole emoji set, for the same reason as
// rolesUpdatePayload: a wholesale replace cannot leave a deleted emoji on screen
// after a dropped event.
type emojiUpdatePayload struct {
	Emoji []emojiInfo `json:"emoji"`
}

// gameActivityPolicyPayload is game_activity_policy's payload and auth_ok's game_activity_policy key.
type gameActivityPolicyPayload struct {
	Enabled bool `json:"enabled"`
}

// buildGameActivityPolicy constructs a game_activity_policy broadcast.
func buildGameActivityPolicy(enabled bool) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeGameActivityPolicy,
		Payload: gameActivityPolicyPayload{Enabled: enabled},
	})
}

// uploadPolicyPayload is upload_policy's payload: the file-type lists in force, as in auth_ok.
type uploadPolicyPayload struct {
	BlockedExtensions []string `json:"blocked_extensions"`
	AllowedExtensions []string `json:"allowed_extensions"`
}

type chatSendOKPayload struct {
	ClientMessageID string `json:"client_message_id,omitempty"`
	Deduplicated    bool   `json:"deduplicated,omitempty"`
	MessageID       int64  `json:"message_id"`
	Timestamp       string `json:"timestamp"`
	// SkippedAttachmentIDs are requested uploads the send did not attach; absent when all were attached.
	SkippedAttachmentIDs []string `json:"skipped_attachment_ids,omitempty"`
}

type chatEditedPayload struct {
	MessageID int64  `json:"message_id"`
	ChannelID int64  `json:"channel_id"`
	Content   string `json:"content"`
	EditedAt  string `json:"edited_at"`
	// Mentions/MentionsEveryone are re-resolved from the edited content.
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
	// MentionRoles: see chatMessagePayload.MentionRoles.
	MentionRoles []int64 `json:"mention_roles"`
	// MentionsHere: see chatMessagePayload.MentionsHere.
	MentionsHere bool `json:"mentions_here"`
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
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
	Muted     bool   `json:"muted"`
	Deafened  bool   `json:"deafened"`
	// Speaking is always false on the wire: the column is reset on insert and never
	// updated; LiveKit's ActiveSpeakersChanged is the speaking authority. Kept for
	// protocol compatibility.
	Speaking    bool `json:"speaking"`
	Camera      bool `json:"camera"`
	Screenshare bool `json:"screenshare"`
	// ServerMuted/ServerDeafened are moderator-imposed. Muted/Deafened are always set
	// alongside, so a client ignoring these still renders the user silenced; these
	// let the UI tell a self-mute from one the user may not lift.
	ServerMuted    bool `json:"server_muted"`
	ServerDeafened bool `json:"server_deafened"`
}

// voiceMovedPayload tells one client its moderator moved it to another voice
// channel; it tears down its LiveKit session and re-joins via voice_join.
type voiceMovedPayload struct {
	ToChannelID int64 `json:"to_channel_id"`
	// Reason says why the server moved the client ("afk" for the idle sweep); omitted
	// for a moderator move.
	Reason string `json:"reason,omitempty"`
	// ByUserID is the moderator who made the move; omitted for the AFK sweep (no actor).
	ByUserID int64 `json:"by_user_id,omitempty"`
}

// voiceMovedReasonAFK is voice_moved's reason for a move by the AFK sweep.
const voiceMovedReasonAFK = "afk"

// voiceDisconnectedPayload tells one client a moderator removed it from voice.
type voiceDisconnectedPayload struct {
	ChannelID int64  `json:"channel_id"`
	Reason    string `json:"reason"`
}

type voiceConfigPayload struct {
	ChannelID int64  `json:"channel_id"`
	Quality   string `json:"quality"`
	Bitrate   int    `json:"bitrate"`
	MaxUsers  int    `json:"max_users"`
	// ThresholdMode, MixingThreshold and TopSpeakers are reserved: shipped on every
	// frame but never read by the client, since LiveKit's ActiveSpeakersChanged is
	// authoritative. Kept for protocol compatibility; do not build on them without a reader.
	ThresholdMode   string `json:"threshold_mode"`
	MixingThreshold int    `json:"mixing_threshold"`
	TopSpeakers     int    `json:"top_speakers"`
}

type voiceTokenPayload struct {
	ChannelID   int64  `json:"channel_id"`
	Token       string `json:"token"`
	URL         string `json:"url"`
	DirectURL   string `json:"direct_url,omitempty"`
	IsKeyHolder bool   `json:"is_key_holder"`
}

// voiceE2EEAnnounceBroadcast is the server-to-client relay with user_id added.
// Signature is the sender's identity-key signature over the ephemeral key, relayed
// verbatim and omitted for legacy announces.
type voiceE2EEAnnounceBroadcast struct {
	UserID    int64  `json:"user_id"`
	PublicKey string `json:"public_key"`
	Signature string `json:"signature,omitempty"`
	// VideoDecode is the sender's sanitized decodable video codec list.
	VideoDecode []string `json:"video_decode,omitempty"`
	// IdentityPublicKey is the announcing connection's device identity key, omitted
	// when none was sent. Peers verify Signature against it when present, else the
	// member's published key.
	IdentityPublicKey string `json:"identity_public_key,omitempty"`
}

// voiceE2EEOfferRelay is the server-to-client relay with from_user_id.
type voiceE2EEOfferRelay struct {
	FromUserID   int64  `json:"from_user_id"`
	EncryptedKey string `json:"encrypted_key"`
	IV           string `json:"iv"`
}

type voiceLeavePayload struct {
	ChannelID int64 `json:"channel_id"`
	UserID    int64 `json:"user_id"`
}

type channelDeletePayload struct {
	ID int64 `json:"id"`
}

type serverRestartPayload struct {
	Reason       RestartReason `json:"reason"`
	DelaySeconds int           `json:"delay_seconds"`
	// ReconnectSpreadMS is the window after delay_seconds over which clients spread their redial.
	ReconnectSpreadMS int64 `json:"reconnect_spread_ms"`
}

// restartSpreadMS spreads a restart's redials over 10 ms per connected client,
// capped at 30 s.
func restartSpreadMS(connected int) int64 {
	return min(int64(connected)*10, 30_000)
}

// callSignalPayload carries an ephemeral DM call signal (call_incoming /
// call_declined). There is no call id: the call is presence in the DM's voice
// channel.
type callSignalPayload struct {
	ChannelID int64  `json:"channel_id"`
	FromUser  int64  `json:"from_user"`
	Username  string `json:"username"`
}

// buildJSON marshals v, logging on failure.
func buildJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		slog.Error("buildJSON marshal failed", "error", err, "type", fmt.Sprintf("%T", v))
		// Fall back to a generic error rather than panic.
		b, _ = json.Marshal(map[string]string{"type": "error", "message": "internal marshal error"})
	}
	return b
}

func buildErrorMsg(code, message string) []byte {
	return buildJSON(map[string]any{
		"type": MsgTypeError,
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// buildErrorMsgWithID is buildErrorMsg echoing the originating command's request
// id so the client can correlate the failure (e.g. mark an optimistic send failed).
// Empty reqID gives the id-less envelope.
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

// buildAuthError produces an auth_error; the client treats it as non-recoverable
// and stops reconnecting.
func buildAuthError(message string) []byte {
	return buildJSON(map[string]any{
		"type": MsgTypeAuthError,
		"payload": map[string]string{
			"message": message,
		},
	})
}

// minClientEpoch is the oldest wire epoch the auth handshake accepts. 0 for epoch
// 1 only, because clients up to v1.2.0-alpha.4 send no epoch and must keep
// connecting. One accepted epoch by policy: set this to ProtocolEpoch on the next
// bump; widen to ProtocolEpoch-1 only if a compatibility window is wanted.
const minClientEpoch = 0

// buildProtocolEpochError is the auth_error for an epoch outside
// [minClientEpoch, ProtocolEpoch]. The message names which side to update; the
// numbers let a client decide.
func buildProtocolEpochError(clientEpoch int) []byte {
	message := fmt.Sprintf("this client speaks protocol epoch %d but the server needs %d; update the client",
		clientEpoch, ProtocolEpoch)
	if clientEpoch > ProtocolEpoch {
		message = fmt.Sprintf("this client speaks protocol epoch %d but the server only speaks %d; update the server",
			clientEpoch, ProtocolEpoch)
	}
	return buildJSON(map[string]any{
		"type": MsgTypeAuthError,
		"payload": map[string]any{
			"message":      message,
			"code":         ErrCodeProtocolEpoch,
			"client_epoch": clientEpoch,
			"server_epoch": ProtocolEpoch,
			"min_epoch":    minClientEpoch,
		},
	})
}

// buildPresenceMsg constructs a presence broadcast. status is taken verbatim:
// callers pass db.BroadcastStatus(status) for everyone but the owner. A builder
// that always collapsed invisible could never produce the owner's own message.
func buildPresenceMsg(userID int64, status string, customStatus *string, activity *gameActivity, listening *listeningActivity) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypePresence,
		Payload: presencePayload{UserID: userID, Status: status, CustomStatus: customStatus, Activity: activity, Listening: listening},
	})
}

// buildMemberJoin constructs a member_join broadcast. user.Status should already
// carry the ConnectStatus-mapped value (serve.go's applyConnectStatus); the
// BroadcastStatus collapse here makes an invisible connector report "offline".
func buildMemberJoin(user *db.User, roleName string, roleIDs []int64) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeMemberJoin,
		Payload: memberJoinPayload{
			User:   memberPayloadFor(user, roleName, roleIDs),
			Status: db.BroadcastStatus(user.Status),
		},
	})
}

func buildMemberUpdate(userID int64, roleName string, roleIDs []int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeMemberUpdate,
		Payload: memberUpdatePayload{UserID: userID, Role: roleName, RoleIDs: roleIDs},
	})
}

// UserUpdate is the profile snapshot a user_update carries; a struct because every
// field is a nullable string and a swapped pair would compile.
type UserUpdate struct {
	UserID            int64
	Username          string
	Avatar            *string
	DisplayName       *string
	About             *string
	IdentityPublicKey *string
	Banner            *string // /api/v1/files/<id> path; nil = none
	BannerColor       *string
}

func buildUserUpdate(u UserUpdate) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeUserUpdate,
		Payload: userUpdatePayload(u),
	})
}

func buildMemberBan(userID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeMemberBan,
		Payload: memberBanPayload{UserID: userID},
	})
}

// buildRolesUpdate carries the full role list, highest position first like ready.
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

// buildEmojiUpdate carries the full custom-emoji set in server list order.
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

// buildUploadPolicy carries both file-type lists, always arrays so an emptied
// list is [] not absent: the client replaces both wholesale.
func buildUploadPolicy(blocked, allowed []string) []byte {
	if blocked == nil {
		blocked = []string{}
	}
	if allowed == nil {
		allowed = []string{}
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeUploadPolicy,
		Payload: uploadPolicyPayload{BlockedExtensions: blocked, AllowedExtensions: allowed},
	})
}

func buildChatSendOK(requestID string, msgID int64, timestamp, clientMessageID string, duplicate bool, skippedAttachmentIDs []string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChatSendOK,
		ID:      requestID,
		Payload: chatSendOKPayload{MessageID: msgID, Timestamp: timestamp, ClientMessageID: clientMessageID, Deduplicated: duplicate, SkippedAttachmentIDs: skippedAttachmentIDs},
	})
}

func buildChatEdited(msgID, channelID int64, content, editedAt string, mentions, mentionRoles []int64, mentionsEveryone, mentionsHere bool) []byte {
	if mentions == nil {
		mentions = []int64{}
	}
	if mentionRoles == nil {
		mentionRoles = []int64{}
	}
	return buildJSON(wsMsg{
		Type: MsgTypeChatEdited,
		Payload: chatEditedPayload{
			MessageID:        msgID,
			ChannelID:        channelID,
			Content:          content,
			EditedAt:         editedAt,
			Mentions:         mentions,
			MentionRoles:     mentionRoles,
			MentionsEveryone: mentionsEveryone,
			MentionsHere:     mentionsHere,
		},
	})
}

func buildChatDeleted(msgID, channelID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChatDeleted,
		Payload: chatDeletedPayload{MessageID: msgID, ChannelID: channelID},
	})
}

// buildChatBulkDeleted emits ids as [] not null when nothing was purged.
func buildChatBulkDeleted(channelID int64, ids []int64) []byte {
	if ids == nil {
		ids = []int64{}
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeChatBulkDeleted,
		Payload: chatBulkDeletedPayload{ChannelID: channelID, IDs: ids},
	})
}

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

// buildVoiceMoved constructs voice_moved. reason is "" for a moderator move and
// "afk" for the sweep; byUserID is the moderator, 0 (omitted) for the sweep.
func buildVoiceMoved(toChannelID int64, reason string, byUserID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceMoved,
		Payload: voiceMovedPayload{ToChannelID: toChannelID, Reason: reason, ByUserID: byUserID},
	})
}

// buildVoiceDisconnected is for the client a moderator removed from voice.
func buildVoiceDisconnected(channelID int64, reason string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceDisconnected,
		Payload: voiceDisconnectedPayload{ChannelID: channelID, Reason: reason},
	})
}

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

// buildVoiceToken constructs voice_token. url is the proxy path ("/livekit");
// direct_url is the raw LiveKit URL for localhost clients. directURL is the
// server's own dial address, so it is sent only when its host is loopback:
// anything else (a docker service name, LiveKit Cloud) may not resolve on the
// client, which then tunnels.
func buildVoiceToken(channelID int64, token string, proxyPath string, directURL string, isKeyHolder bool) []byte { //nolint:unparam // kept configurable for proxy path flexibility
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceToken,
		Payload: voiceTokenPayload{
			ChannelID:   channelID,
			Token:       token,
			URL:         proxyPath,
			DirectURL:   loopbackURLOrEmpty(directURL),
			IsKeyHolder: isKeyHolder,
		},
	})
}

// buildVoiceE2EEAnnounce constructs a voice_e2ee_announce relay; an empty
// signature or video decode list is omitted.
func buildVoiceE2EEAnnounce(userID int64, a e2eeAnnounce) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceE2EEAnnounceBC,
		Payload: voiceE2EEAnnounceBroadcast{
			UserID:            userID,
			PublicKey:         a.key,
			Signature:         a.sig,
			VideoDecode:       a.videoDecode,
			IdentityPublicKey: a.identityKey,
		},
	})
}

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

func buildVoiceLeave(channelID, userID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceLeaveBC,
		Payload: voiceLeavePayload{ChannelID: channelID, UserID: userID},
	})
}

// buildChannelCreateFor constructs a channel_create for one client, carrying its
// own affordance verdicts.
func buildChannelCreateFor(ch *db.Channel, private bool, a channelAffordances) []byte {
	p := channelPayloadFrom(ch, private)
	p.CanSend = &a.CanSend
	p.CanModerateVoice = &a.CanModerateVoice
	p.CanMoveVoice = &a.CanMoveVoice
	p.CanDeleteOthers = &a.CanDeleteOthers
	p.CanPin = &a.CanPin
	p.CanReact = &a.CanReact
	return buildJSON(wsMsg{
		Type:    MsgTypeChannelCreate,
		Payload: p,
	})
}

func buildChannelUpdate(ch *db.Channel, private bool) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChannelUpdate,
		Payload: channelPayloadFrom(ch, private),
	})
}

func buildChannelDelete(channelID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChannelDelete,
		Payload: channelDeletePayload{ID: channelID},
	})
}

// buildDMChannelOpen constructs a dm_channel_open for one viewer. The payload is
// db.DMChannelInfo, the shape REST and ready carry. It is built per viewer
// because recipient/recipients are relative to the reader and each participant's
// status is the live one (presentDMStatuses), not the users.status row.
func buildDMChannelOpen(info db.DMChannelInfo, viewerID int64, liveStatus func(userID int64) string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeDMChannelOpen,
		Payload: presentDMStatuses([]db.DMChannelInfo{info}, viewerID, liveStatus)[0],
	})
}

// buildDMChannelOpenFor announces a 1:1 DM to the user on the other end. Returns
// nil if recipient is nil.
func buildDMChannelOpenFor(channelID int64, recipient *db.User, viewerID int64, liveStatus func(userID int64) string) []byte {
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
		DisplayName: displayName,
	}
	return buildDMChannelOpen(db.DMChannelInfo{
		ChannelID:  channelID,
		Recipient:  other,
		Recipients: []db.DMUser{other},
	}, viewerID, liveStatus)
}

// dmRequestSenderPayload is the sender profile a dm_request carries, so the inbox
// renders without a second fetch; mirrors GET /api/v1/dm-requests.
type dmRequestSenderPayload struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Avatar      string `json:"avatar"`
}

// dmRequestPreviewPayload is the held message's preview, present only on creation.
type dmRequestPreviewPayload struct {
	MessageID int64  `json:"message_id"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
}

type dmRequestPayload struct {
	ID        int64                    `json:"id"`
	State     string                   `json:"state"`
	ChannelID int64                    `json:"channel_id"`
	Sender    dmRequestSenderPayload   `json:"sender"`
	Preview   *dmRequestPreviewPayload `json:"preview"`
	CreatedAt string                   `json:"created_at"`
	DecidedAt *string                  `json:"decided_at"`
}

// buildDMRequest constructs a dm_request: sent once on creation (Preview set) and
// again with a new State on every transition (Preview nil); see DMRequestEvent.
func buildDMRequest(p dmRequestPayload) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeDMRequest,
		Payload: p,
	})
}

// buildDMRequestForCreation builds the creation-time dm_request for a staged
// request: req from service.SendMessageResult.RequestCreatedFor, sender from
// SenderUser, preview from RequestPreview.
func buildDMRequestForCreation(req *db.MessageRequest, sender *db.User, preview *service.DMRequestPreview) []byte {
	avatar := ""
	if sender.Avatar != nil {
		avatar = *sender.Avatar
	}
	displayName := ""
	if sender.DisplayName != nil {
		displayName = *sender.DisplayName
	}
	var previewPayload *dmRequestPreviewPayload
	if preview != nil {
		previewPayload = &dmRequestPreviewPayload{
			MessageID: preview.MessageID,
			Content:   preview.Content,
			Timestamp: preview.Timestamp,
		}
	}
	return buildDMRequest(dmRequestPayload{
		ID:        req.ID,
		State:     req.State,
		ChannelID: req.ChannelID,
		Sender: dmRequestSenderPayload{
			ID: sender.ID, Username: sender.Username,
			DisplayName: displayName, Avatar: avatar,
		},
		Preview:   previewPayload,
		CreatedAt: req.CreatedAt,
		DecidedAt: req.DecidedAt,
	})
}

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

func buildServerRestartMsg(reason RestartReason, delaySeconds int, spreadMS int64) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeServerRestart,
		Payload: serverRestartPayload{
			Reason:            reason,
			DelaySeconds:      delaySeconds,
			ReconnectSpreadMS: spreadMS,
		},
	})
}
