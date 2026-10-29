package db

import "time"

// User represents a row in the users table.
type User struct {
	ID           int64
	Username     string
	PasswordHash string `json:"-"`
	Avatar       *string
	RoleID       int64
	TOTPSecret   *string `json:"-"`
	Status       string
	CreatedAt    string
	LastSeen     *string
	Banned       bool
	BanReason    *string
	BanExpires   *string
	// IdentityPublicKey is the long-term E2EE identity public key (base64,
	// ECDSA P-256) used for TOFU pinning of voice E2EE announces. Nil = not
	// published (legacy client).
	IdentityPublicKey *string
	// DisplayName is the optional nickname shown instead of Username. Nil =
	// unset, and every renderer falls back to Username. Mentions still resolve
	// against Username alone — it is the unique key.
	DisplayName *string
	// RegistrationStatus is 'active', 'pending' (an approval-mode
	// application holding its username until an admin approves it)
	// or 'denied' (anonymised and locked for good, since audit rows keep
	// the id).
	RegistrationStatus string
	// About is the optional profile bio shown in the profile popup. Nil = unset.
	About *string
	// CustomStatus is the optional free-text status line shown under the name.
	// Nil = unset. Set over the WebSocket presence path and cleared on logout.
	CustomStatus *string
	// CustomStatusExpiresAt is the instant CustomStatus clears itself, as
	// dbtime.ISOLayout text. Nil = no expiry. Only ever set with a
	// non-nil CustomStatus.
	CustomStatusExpiresAt *string
	// BannerID is the attachment id of the profile banner image (migration
	// 069). Nil = no image. The file is public while this names it.
	BannerID *string
	// BannerColor is the profile banner colour, lower-case #rgb or #rrggbb.
	// Nil = unset.
	BannerColor *string
}

// BannerPath is the URL the banner image is served from, nil when none. A
// method, so a caller that only holds a User needs no db function.
func (u *User) BannerPath() *string {
	return BannerURL(u.BannerID)
}

// EffectiveDisplayName returns the name to render for the user: the display
// name when set and non-empty, the username otherwise. Every payload builder
// goes through this so the fallback cannot be spelled three different ways.
func (u *User) EffectiveDisplayName() string {
	if u == nil {
		return ""
	}
	if u.DisplayName != nil && *u.DisplayName != "" {
		return *u.DisplayName
	}
	return u.Username
}

// Session represents a row in the sessions table.
type Session struct {
	ID        int64
	UserID    int64
	TokenHash string `json:"-"`
	Device    string
	IP        string
	CreatedAt string
	LastUsed  string
	ExpiresAt string
	// Unseen is the new-login signal: true from the login that created
	// the session until the account lists its sessions from another device.
	Unseen bool
}

// APIToken represents a row in the api_tokens table — a long-lived, revocable
// bearer token that authenticates as UserID with that user's role/permissions.
// Raw tokens are never stored; TokenHash is the SHA-256 hex, like Session.
type APIToken struct {
	ID        int64
	UserID    int64
	TokenHash string `json:"-"`
	Label     string
	CreatedAt string
	LastUsed  *string
	ExpiresAt *string // nil = never expires
	RevokedAt *string // nil = active
}

// APITokenListItem is one row of the admin/CLI token listing. It carries the
// owning user's name for display and deliberately omits the hash.
type APITokenListItem struct {
	ID        int64   `json:"id"`
	UserID    int64   `json:"user_id"`
	Username  string  `json:"username"`
	Label     string  `json:"label"`
	CreatedAt string  `json:"created_at"`
	LastUsed  *string `json:"last_used"`
	ExpiresAt *string `json:"expires_at"`
	RevokedAt *string `json:"revoked_at"`
}

// Invite represents a row in the invites table.
type Invite struct {
	ID        int64
	Code      string
	CreatedBy int64
	// CreatorUsername is the invite creator's username, joined at read time for
	// the invite list. Empty when the creator's account was erased.
	CreatorUsername string
	Uses            int
	MaxUses         *int
	ExpiresAt       *string
	Revoked         bool
	CreatedAt       string
}

// Expired reports whether the invite's expiry has passed at now. A nil
// ExpiresAt never expires. The stored format is RFC3339 UTC (see CreateInvite);
// an unparseable stamp is treated as expired, matching the redemption query,
// whose strftime('%s', expires_at) yields NULL for such a stamp and so never
// admits it.
func (i *Invite) Expired(now time.Time) bool {
	if i.ExpiresAt == nil {
		return false
	}
	t, err := time.Parse(time.RFC3339, *i.ExpiresAt)
	if err != nil {
		return true
	}
	return !now.Before(t)
}

// Channel represents a row in the channels table.
type Channel struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	// CategoryID / CategoryPosition come from the LEFT JOIN on
	// channel_categories (migration 072). CategoryID 0 means uncategorized,
	// and Category is then "". Both are identical for every recipient.
	CategoryID       int64   `json:"category_id"`
	CategoryPosition int     `json:"category_position"`
	Topic            string  `json:"topic"`
	Position         int     `json:"position"`
	SlowMode         int     `json:"slow_mode"`
	Archived         bool    `json:"archived"`
	CreatedAt        string  `json:"created_at"`
	VoiceMaxUsers    int     `json:"voice_max_users"`
	VoiceQuality     *string `json:"voice_quality,omitempty"`
	MixingThreshold  *int    `json:"mixing_threshold,omitempty"`
	VoiceMaxVideo    int     `json:"voice_max_video"`
	// NSFW marks the channel as possibly carrying sensitive content. It is
	// metadata only: the server stores, ships and audits it but imposes no
	// content behaviour of its own (see migration 025). Clients decide what
	// to do with it — the desktop client shows a per-session age gate.
	NSFW bool `json:"nsfw"`
	// AFK marks the server's one AFK voice channel (migration 068): members
	// parked there can only listen. At most one row carries it.
	AFK bool `json:"afk"`
	// Thread is set on a thread row only (migration 074); never on the wire.
	Thread ChannelThread `json:"-"`
	Forum  *ChannelForum `json:"forum,omitempty"` // forum rows only (migration 075)
	// ChannelPassword carries password_protected (migration 086). The hash is
	// never part of this struct.
	ChannelPassword
}

// Message represents a row in the messages table.
type Message struct {
	ID        int64
	ChannelID int64
	UserID    int64
	Content   string
	ReplyTo   *int64
	EditedAt  *string
	Deleted   bool
	Pinned    bool
	Timestamp string
	// MentionsEveryone: an @everyone or @here resolved and the author held
	// MENTION_EVERYONE. Per-user mentions live in message_mentions.
	MentionsEveryone bool
	// Kind is MessageKindUser for an ordinary message. Every other value is a
	// row only the server writes: a call log row or a group event row.
	Kind         int64
	ThreadJoined []int64 // users this send newly made thread followers; send transactions only
}

// MessageWithUser joins a Message with the author's public fields.
type MessageWithUser struct {
	Message
	Username string
	Avatar   *string
}

// ReactionCount is an aggregated reaction count for a single emoji.
type ReactionCount struct {
	Emoji     string
	Count     int
	MeReacted bool
}

// MessageSearchResult is a row returned by the FTS5 message search.
type MessageSearchResult struct {
	MessageID        int64               `json:"message_id"`
	ChannelID        int64               `json:"channel_id"`
	ChannelName      string              `json:"channel_name"`
	User             UserPublic          `json:"user"`
	Content          string              `json:"content"`
	Timestamp        string              `json:"timestamp"`
	Mentions         []int64             `json:"mentions"`
	MentionsEveryone bool                `json:"mentions_everyone"`
	Sticker          *MessageStickerInfo `json:"sticker,omitempty"`
}

// SearchPage selects one page of full-text search results. The zero values
// keep the original behaviour: best match first, no cursor.
type SearchPage struct {
	Limit int
	// Recent orders newest first (message id descending) instead of by rank.
	// Relevance ranks only the newest 2,000 in-scope matches; Recent reaches
	// older ones.
	Recent bool
	// Before, when positive, keeps only messages with an id below it — the
	// cursor for the next page of a Recent search.
	Before int64
}

// UserPublic is the public-facing user shape for API responses.
type UserPublic struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar,omitempty"`
}

// MessageAPIResponse matches the docs/api.md shape for GET /channels/{id}/messages.
type MessageAPIResponse struct {
	ID          int64            `json:"id"`
	ChannelID   int64            `json:"channel_id"`
	User        UserPublic       `json:"user"`
	Content     string           `json:"content"`
	ReplyTo     *int64           `json:"reply_to"`
	Attachments []AttachmentInfo `json:"attachments"`
	Reactions   []ReactionInfo   `json:"reactions"`
	Pinned      bool             `json:"pinned"`
	EditedAt    *string          `json:"edited_at"`
	Deleted     bool             `json:"deleted"`
	Timestamp   string           `json:"timestamp"`
	// Mentions is the resolved user ids the message mentions (never nil);
	// MentionsEveryone reports an authorized @everyone/@here.
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
	// RoleMentions adds mention_roles: the roles whose @role token
	// cleared the mention gate. Embedded so its json tag lives outside
	// models.go, whose tag count is pinned.
	RoleMentions
	// ReferencedMessage is the reply parent's snippet, computed at read time
	// (never stored). Null when this is not a reply or the parent is gone or
	// in another channel.
	ReferencedMessage *ReferencedMessage `json:"referenced_message"`
	// Kind and Call are set only on a call log row (kind "call") and omitted
	// for an ordinary message. See CallInfo.
	Kind string    `json:"kind,omitempty"`
	Call *CallInfo `json:"call,omitempty"`
	// GroupEvent is set only on a group event row (group_add to group_icon).
	GroupEvent *GroupEventInfo `json:"group_event,omitempty"`
	// Forward is set only on a forwarded message. See ForwardInfo.
	Forward *ForwardInfo `json:"forward,omitempty"`
	// Poll is set only on a poll, Thread only on a thread starter.
	Poll   *PollInfo   `json:"poll,omitempty"`
	Thread *ThreadInfo `json:"thread,omitempty"`
	// Sticker is set only on a sticker message. See MessageStickerInfo.
	Sticker *MessageStickerInfo `json:"sticker,omitempty"`
}

// GroupEventInfo is the group_event block of a group DM row. Which fields are
// set depends on the kind: add and remove carry TargetUserID, rename carries
// Name ("" means the name was removed) and icon carries IconRemoved. A leave
// row carries none, so it encodes as {}.
type GroupEventInfo struct {
	TargetUserID int64   `json:"target_user_id,omitempty"`
	Name         *string `json:"name,omitempty"`
	IconRemoved  *bool   `json:"icon_removed,omitempty"`
}

// CallInfo is the call block of a call log row. Times use the message
// timestamp layout. EndedAt is nil while the call is live.
type CallInfo struct {
	StartedAt    string  `json:"started_at"`
	EndedAt      *string `json:"ended_at"`
	Participants []int64 `json:"participants"`
}

// ReferencedMessage is the snippet of a reply's parent. A deleted parent is
// redacted to {id, deleted: true}: no author, no content.
type ReferencedMessage struct {
	ID             int64       `json:"id"`
	User           *UserPublic `json:"user"`
	Content        string      `json:"content"`
	Deleted        bool        `json:"deleted"`
	HasAttachments bool        `json:"has_attachments"`
	// IsSystem marks a server-written row (a call log or group event row, any
	// kind other than MessageKindUser and the welcome row a member waves at).
	// It is server-side only: a reply to one is refused, so it never reaches
	// the wire.
	IsSystem bool `json:"-"`
}

// ReactionInfo is the reaction shape in API responses.
type ReactionInfo struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Me    bool   `json:"me"`
}

// ReactionUser is one reactor in the who-reacted list returned by
// GET /channels/{id}/messages/{messageId}/reactions/{emoji}/users. Avatar is a
// plain string ("" = none) rather than UserPublic's pointer: the tooltip that
// consumes this never distinguishes null from empty.
type ReactionUser struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

// VoiceState represents a row in the voice_states table.
// It tracks which voice channel a user is in and their current audio state.
//
// ServerMuted/ServerDeafened are moderator-imposed and, unlike Muted/Deafened,
// the user cannot clear them: while set, their own voice_mute/voice_deafen
// unmute attempts are refused. They are scoped to the voice session — the row
// is deleted on leave — but survive a channel switch.
type VoiceState struct {
	UserID         int64  `json:"user_id"`
	ChannelID      int64  `json:"channel_id"`
	Username       string `json:"username"`
	Muted          bool   `json:"muted"`
	Deafened       bool   `json:"deafened"`
	Speaking       bool   `json:"speaking"`
	Camera         bool   `json:"camera"`
	Screenshare    bool   `json:"screenshare"`
	ServerMuted    bool   `json:"server_muted"`
	ServerDeafened bool   `json:"server_deafened"`
	JoinedAt       string `json:"-"`
	// ServerMutedBy is the owning moderation_actions id when ServerMuted was
	// set by a timeout — nil for a manual
	// moderator mute or when unmuted. Server-side only: never marshaled
	// into a client-facing payload (GetVoiceState/GetUserVoiceState is the
	// one read that populates it, for RestoreModFlags' own use; the bulk
	// reads behind voice_state/ready leave it unset). No json tag needed
	// since ChannelVoiceStates/AllVoiceStates never populate it.
	ServerMutedBy *int64
}

// ChannelUnread holds per-user unread data for a single channel.
type ChannelUnread struct {
	LastMessageID int64 `json:"last_message_id"`
	UnreadCount   int   `json:"unread_count"`
	// MentionCount is read_states.mention_count: unread messages that mention
	// this user directly or via an authorized @everyone/@here. Zeroed by
	// channel_focus, never advanced by an edit.
	MentionCount int `json:"mention_count"`
	// LastReadMessageID is read_states.last_message_id: the caller's read
	// pointer, 0 when the caller has no row for the channel. It is not
	// LastMessageID, which is the newest live message in the channel.
	LastReadMessageID int64 `json:"last_read_message_id"`
}

// ServerStats contains aggregate counts for the admin dashboard.
type ServerStats struct {
	UserCount    int64 `json:"user_count"`
	MessageCount int64 `json:"message_count"`
	ChannelCount int64 `json:"channel_count"`
	InviteCount  int64 `json:"invite_count"`
	DBSizeBytes  int64 `json:"db_size_bytes"`
	OnlineCount  int   `json:"online_count"`
}

// UserWithRole extends User with the name and hierarchy position of the
// user's role.
type UserWithRole struct {
	User
	RoleName     string `json:"role_name"`
	RolePosition int    `json:"role_position"`
	// RoleIDs is every held role, top role first; never nil from ListAllUsers.
	RoleIDs []int64
}

// AuditEntry represents a single row from the audit_log table joined with the
// actor's username.
type AuditEntry struct {
	ID         int64  `json:"id"`
	ActorID    int64  `json:"actor_id"`
	ActorName  string `json:"actor_name"`
	Action     string `json:"action"`
	TargetType string `json:"target_type"`
	TargetID   int64  `json:"target_id"`
	Detail     string `json:"detail"`
	// SubjectToken is the deletion-marker token of an erased subject the row
	// targeted: set by the erasure on rows that lost their target id,
	// and on the erasure's own rows. ActorToken is the same for an erased
	// subject who acted, so a row naming two erased subjects keeps both.
	// Both are empty on every other row.
	SubjectToken string `json:"subject_token,omitempty"`
	ActorToken   string `json:"actor_token,omitempty"`
	CreatedAt    string `json:"created_at"`
}

// Emoji represents a row in the emoji table: one server-wide custom emoji.
//
// StoredAs is the storage-layer UUID the image bytes live under (the table's
// legacy column name is `filename`); it is never shown to a user and never
// derived from anything the uploader sent. Shortcode is always lowercase --
// the only spelling the validator admits -- which is what makes the table's
// plain UNIQUE index a case-insensitive one.
type Emoji struct {
	ID         int64  `json:"id"`
	Shortcode  string `json:"shortcode"`
	StoredAs   string `json:"-"`
	MimeType   string `json:"-"`
	UploadedBy int64  `json:"uploaded_by"`
	CreatedAt  string `json:"created_at"`
}

// sessionTTL is the idle window: a session expires this long after it was
// created or last touched (TouchSessions slides it). TouchSessions also caps
// expires_at at created_at + 365 days, the absolute lifetime from sign-in,
// in its query (sessions.sql).
const sessionTTL = 30 * 24 * time.Hour

// Registration statuses of a users row.
const (
	RegistrationActive  = "active"
	RegistrationPending = "pending"
	RegistrationDenied  = "denied"
)

// PendingApproval reports an approval-mode application that no admin has
// decided yet.
func (u *User) PendingApproval() bool { return u.RegistrationStatus == RegistrationPending }
