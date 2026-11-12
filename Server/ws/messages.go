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
	// CustomStatus is the free-text status line. Always present (null when unset), not omitempty: a client
	// must tell "cleared" from "not mentioned".
	CustomStatus *string `json:"custom_status"`
	// Activity is the game being played; always present like CustomStatus, blanked for all but the owner
	// while invisible.
	Activity  *gameActivity      `json:"activity"`
	Listening *listeningActivity `json:"listening"`
	// Mobile is true on the Android app (see mergeLivePresence). Omitted when false and never set on an
	// invisible user's "offline" frame.
	Mobile bool `json:"mobile,omitempty"`
}

type memberUserPayload struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	Role     string  `json:"role"`
	// DisplayName is the nickname to render instead of Username, which stays as the unique handle mentions
	// resolve against.
	DisplayName *string `json:"display_name,omitempty"`
	// IdentityPublicKey is the user's long-term E2EE identity key (base64), pinned by peers on first sight.
	// Omitted when unpublished or not carried.
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
}

// memberJoinUser is memberUserPayload plus the profile fields the member list shows;
// separate because memberUserPayload is also chat_message.user.
type memberJoinUser struct {
	memberUserPayload
	About     *string `json:"about"`
	CreatedAt string  `json:"created_at"`
	// RoleIDs is every held role, top first; Role stays the top role's name. Omitted when the holder list was
	// not read.
	RoleIDs     []int64 `json:"role_ids,omitempty"`
	Banner      *string `json:"banner,omitempty"`
	BannerColor *string `json:"banner_color,omitempty"`
}

type memberJoinPayload struct {
	User memberJoinUser `json:"user"`
	// Status is the viewer-safe presence the connecting user comes online as
	// (db.BroadcastStatus of the ConnectStatus-mapped value): an invisible connector reports
	// "offline". This is BroadcastToAll, so clients must render from this field, or an invisible
	// user shows online until the droppable low-priority correction arrives.
	Status string `json:"status"`
}

type memberUpdatePayload struct {
	UserID  int64   `json:"user_id"`
	Role    string  `json:"role"`
	RoleIDs []int64 `json:"role_ids,omitempty"`
}

type memberUpdateBatchPayload struct {
	Members []memberUpdatePayload `json:"members"`
}

type userUpdatePayload struct {
	UserID   int64   `json:"user_id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	// DisplayName and About are always present (null = cleared) so removal is distinguishable from leaving
	// alone.
	DisplayName       *string `json:"display_name"`
	About             *string `json:"about"`
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
	Banner            *string `json:"banner"`
	BannerColor       *string `json:"banner_color"`
}

type memberBanPayload struct {
	UserID int64 `json:"user_id"`
}

// rolesUpdatePayload carries the whole role list, not a delta: immune to a dropped event leaving a deleted
// role on screen.
type rolesUpdatePayload struct {
	Roles []db.Role `json:"roles"`
}

// emojiInfo is the client-facing shape of one custom emoji; storage id and mime type stay server-side.
type emojiInfo struct {
	ID        int64  `json:"id"`
	Shortcode string `json:"shortcode"`
	URL       string `json:"url"`
}

// emojiUpdatePayload carries the whole emoji set, for the same reason as rolesUpdatePayload.
type emojiUpdatePayload struct {
	Emoji []emojiInfo `json:"emoji"`
}

type gameActivityPolicyPayload struct {
	Enabled bool `json:"enabled"`
}

func buildGameActivityPolicy(enabled bool) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeGameActivityPolicy,
		Payload: gameActivityPolicyPayload{Enabled: enabled},
	})
}

// videoBitrateCapPayload is video_bitrate_cap's payload and auth_ok's key: per-person video
// upload cap in bits per second (camera and screen together); 0 means no cap.
type videoBitrateCapPayload struct {
	MaxVideoBitrate int `json:"max_video_bitrate"`
}

func buildVideoBitrateCap(bitrate int) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVideoBitrateCap,
		Payload: videoBitrateCapPayload{MaxVideoBitrate: bitrate},
	})
}

type uploadPolicyPayload struct {
	BlockedExtensions []string `json:"blocked_extensions"`
	AllowedExtensions []string `json:"allowed_extensions"`
}

type channelDeletePayload struct {
	ID int64 `json:"id"`
}

type serverRestartPayload struct {
	Reason            RestartReason `json:"reason"`
	DelaySeconds      int           `json:"delay_seconds"`
	ReconnectSpreadMS int64         `json:"reconnect_spread_ms"`
}

func restartSpreadMS(connected int) int64 {
	return min(int64(connected)*10, 30_000)
}

func buildJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		slog.Error("buildJSON marshal failed", "error", err, "type", fmt.Sprintf("%T", v))
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

// buildErrorMsgWithID is buildErrorMsg echoing the originating request id so the client can correlate the
// failure; empty reqID gives the id-less envelope.
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

// buildAuthError produces an auth_error; the client treats it as non-recoverable.
func buildAuthError(message string) []byte {
	return buildJSON(map[string]any{
		"type": MsgTypeAuthError,
		"payload": map[string]string{
			"message": message,
		},
	})
}

// minClientEpoch is the oldest wire epoch the handshake accepts: 0 for epoch 1 only, since
// clients up to v1.2.0-alpha.4 send no epoch. Set to ProtocolEpoch on the next bump; widen
// only if a compatibility window is wanted.
const minClientEpoch = 0

// buildProtocolEpochError is the auth_error for an epoch outside [minClientEpoch, ProtocolEpoch]; the message
// names which side to update.
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

// buildPresenceMsg takes status verbatim: callers pass db.BroadcastStatus(status) for
// everyone but the owner (an always-collapsing builder could not produce the owner's own message).
func buildPresenceMsg(userID int64, status string, customStatus *string, activity *gameActivity, listening *listeningActivity, mobile bool) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypePresence,
		Payload: presencePayload{UserID: userID, Status: status, CustomStatus: customStatus, Activity: activity, Listening: listening, Mobile: mobile},
	})
}

// buildMemberJoin: user.Status should already carry the ConnectStatus-mapped value; the
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

// UserUpdate is the profile snapshot a user_update carries; a struct because every field is a nullable string
// and a swapped pair would compile.
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

// buildUploadPolicy always sends arrays (an emptied list is [], not absent): the client replaces both
// wholesale.
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
