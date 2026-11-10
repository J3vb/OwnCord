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
	// Mobile is true when the user is on the Android app (see mergeLivePresence).
	// Omitted when false, and never set on a frame that stands for an invisible
	// user's "offline".
	Mobile bool `json:"mobile,omitempty"`
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

// memberUpdateBatchPayload is member_update for several members in one frame.
type memberUpdateBatchPayload struct {
	Members []memberUpdatePayload `json:"members"`
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

// videoBitrateCapPayload is video_bitrate_cap's payload and auth_ok's
// video_bitrate_cap key: the per-person video upload cap in bits per second,
// camera and screen share together; 0 means no cap.
type videoBitrateCapPayload struct {
	MaxVideoBitrate int `json:"max_video_bitrate"`
}

// buildVideoBitrateCap constructs a video_bitrate_cap broadcast.
func buildVideoBitrateCap(bitrate int) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVideoBitrateCap,
		Payload: videoBitrateCapPayload{MaxVideoBitrate: bitrate},
	})
}

// uploadPolicyPayload is upload_policy's payload: the file-type lists in force, as in auth_ok.
type uploadPolicyPayload struct {
	BlockedExtensions []string `json:"blocked_extensions"`
	AllowedExtensions []string `json:"allowed_extensions"`
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
func buildPresenceMsg(userID int64, status string, customStatus *string, activity *gameActivity, listening *listeningActivity, mobile bool) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypePresence,
		Payload: presencePayload{UserID: userID, Status: status, CustomStatus: customStatus, Activity: activity, Listening: listening, Mobile: mobile},
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

func buildMemberUpdateBatch(members []memberUpdatePayload) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeMemberUpdateBatch,
		Payload: memberUpdateBatchPayload{Members: members},
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
